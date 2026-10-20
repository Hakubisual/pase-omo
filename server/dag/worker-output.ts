import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { createHash } from "node:crypto";
import type { WorkerOutput, WorkerOutputEntry } from "../../shared/dag.js";
import { splitHarnessWraps } from "../../shared/wrap.js";
import { taskStateDir } from "../task-state.js";
import { getDagSnapshot, type DagStoreOptions } from "./dag-store.js";

const MAX_BYTES = 256 * 1024;
const MAX_TEXT = 24_000;
const MAX_FILES = 4;
const MAX_ENTRIES = 80;
const MAX_ENTRY_TEXT = 8000;
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

/** Never follow a worker path outside its configured store, including directory symlinks. */
async function checkedPath(root: string, segments: string[]): Promise<string> {
  const canonicalRoot = await realpath(root);
  let current = canonicalRoot;
  for (const segment of segments) {
    current = join(current, segment);
    if ((await lstat(current)).isSymbolicLink()) throw new Error("Worker output path is not a regular path");
  }
  const canonical = await realpath(current);
  const rel = relative(canonicalRoot, canonical);
  if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel)) throw new Error("Worker output is outside its store");
  return canonical;
}

function visibleText(value: unknown): string {
  if (typeof value !== "string") return "";
  return stripVTControlCharacters(splitHarnessWraps(value).remaining)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ").trim();
}

const entryId = (value: string) => "wo_" + createHash("sha256").update(value).digest("hex");
function callId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && visibleText(value) === value ? value : undefined;
}
function excerpt(text: string, max = MAX_ENTRY_TEXT): string {
  const tail = text.slice(-max);
  return /^[\udc00-\udfff]/.test(tail) ? tail.slice(1) : tail;
}
function bounded(entry: WorkerOutputEntry): WorkerOutputEntry {
  return entry.text.length <= MAX_ENTRY_TEXT ? entry : { ...entry, text: excerpt(entry.text), truncated: true };
}

/** Preserve visible message boundaries, never prompts, reasoning or tool arguments. */
function messageEntries(raw: unknown, source: string): WorkerOutputEntry[] {
  const entry = object(raw), message = object(entry?.message);
  if (entry?.type !== "message" || !message || message.display === false || message.audience === "model") return [];
  if (message.role !== "assistant" && message.role !== "toolResult") return [];
  const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
  if (!Array.isArray(blocks)) return [];
  const entries: WorkerOutputEntry[] = [];
  const nativeCallId = callId(message.toolCallId);
  const toolName = typeof message.toolName === "string" ? visibleText(message.toolName).slice(0, 128) : undefined;
  for (const [index, rawBlock] of blocks.entries()) {
    const block = object(rawBlock);
    if (!block || block.display === false || block.audience === "model") continue;
    if (block.type === "text") {
      const text = visibleText(block.text);
      if (text) entries.push(bounded({ id: entryId(`${source}:${index}`), type: message.role === "toolResult" ? "tool_result" : "assistant", text,
        ...(message.role === "toolResult" ? { ...(nativeCallId ? { toolCallId: nativeCallId } : {}), ...(toolName ? { toolName } : {}), ...(typeof message.isError === "boolean" ? { isError: message.isError } : {}) } : {}) }));
    } else if (block.type === "toolCall" && typeof block.name === "string") {
      const id = callId(block.id);
      entries.push({ id: entryId(`${source}:${index}`), type: "tool_call", text: "", toolName: visibleText(block.name).slice(0, 128), ...(id ? { toolCallId: id } : {}) });
    }
  }
  return entries;
}

function retain(entries: WorkerOutputEntry[]): { entries: WorkerOutputEntry[]; truncated: boolean } {
  // Bound as we read, retaining complete entry identities rather than cutting
  // a concatenated string through the middle of an unidentified tool result.
  const kept: WorkerOutputEntry[] = []; let used = 0, truncated = false;
  for (const entry of entries.slice().reverse()) {
    if (kept.length === MAX_ENTRIES || used >= MAX_TEXT) { truncated = true; break; }
    const available = MAX_TEXT - used;
    const next = entry.text.length > available ? { ...entry, text: excerpt(entry.text, available), truncated: true } : entry;
    used += next.text.length; kept.push(next); truncated ||= next.truncated === true;
  }
  return { entries: kept.reverse(), truncated };
}

function plainText(entries: WorkerOutputEntry[]): string {
  return entries.map(entry => entry.type === "tool_call" ? `Tool: ${entry.toolName ?? "Unknown"}` : entry.type === "tool_result" ? `Tool result: ${entry.text}` : entry.text).join("\n\n");
}

export async function readWorkerOutput(options: DagStoreOptions & { sessionId: string; taskId: string }): Promise<WorkerOutput> {
  if (!/^st_[A-Za-z0-9_-]{1,253}$/.test(options.taskId)) throw new Error("Invalid worker ID");
  // Resolve the session and its full descendant tree BEFORE touching any worker output file.
  const snapshot = await getDagSnapshot(options);
  const task = snapshot.tasks.find(task => task.id === options.taskId);
  if (!task) throw new Error("Worker does not belong to this session");
  const store = options.taskStateDir ?? taskStateDir(options.cwd);
  const segments = ["children", options.taskId, "sessions", options.taskId];
  let names: string[] = [], warning: string | undefined, truncated = false;
  try {
    const directory = await checkedPath(store, segments);
    names = (await readdir(directory, { withFileTypes: true })).filter(entry => entry.isFile() && entry.name.endsWith(".jsonl")).map(entry => entry.name).sort();
  } catch (error) {
    if (!missing(error)) warning = "Worker transcript could not be read.";
  }
  truncated = names.length > MAX_FILES;
  let entries: WorkerOutputEntry[] = [];
  for (const name of names.slice(-MAX_FILES)) {
    try {
      const file = await checkedPath(store, [...segments, name]);
      const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) throw new Error("Worker output is not a file");
        const offset = Math.max(0, stat.size - MAX_BYTES);
        const bytes = Buffer.alloc(Math.min(MAX_BYTES, stat.size));
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, offset);
        const data = bytes.subarray(0, bytesRead);
        const skip = offset > 0 ? (data.indexOf(10) < 0 ? data.length : data.indexOf(10) + 1) : 0;
        if (offset > 0) truncated = true;
        const tail = data.subarray(skip).toString("utf8");
        let position = offset + skip;
        // A writer may still be appending the final line. Never parse an incomplete JSON record.
        for (const line of tail.split("\n").slice(0, -1)) {
          const source = `${name}:${position}`; position += Buffer.byteLength(line, "utf8") + 1;
          if (!line.trim()) continue;
          try { entries.push(...messageEntries(JSON.parse(line), source)); }
          catch { warning = "Some worker transcript entries could not be read."; }
        }
        const retained = retain(entries); entries = retained.entries; truncated ||= retained.truncated;
      } finally { await handle.close(); }
    } catch { warning = "Worker transcript could not be read completely."; }
  }
  // Older/retained tasks may have only a final response after their child transcript is removed.
  const terminal = ["completed", "failed", "error", "cancelled", "interrupted", "lost"].includes(task.status ?? "");
  if ((!entries.length && !warning) || terminal) {
    try {
      const file = await checkedPath(store, ["tasks", `${options.taskId}.json`]);
      const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        if ((await handle.stat()).size > MAX_BYTES) throw new Error("Oversized task record");
        const record = JSON.parse(await handle.readFile("utf8"));
        if (record.task_id !== options.taskId) throw new Error("Worker record changed");
        const final = visibleText(record.final_response);
        const finalExcerpt = excerpt(final);
        const last = entries.at(-1);
        if (final && !((last?.type === "assistant" || last?.type === "final") && last.text === finalExcerpt)) {
          entries = entries.filter(entry => !((entry.type === "assistant" || entry.type === "final") && entry.text === finalExcerpt));
          entries.push(bounded({ id: entryId(`${options.taskId}:saved-final:${final}`), type: "final", text: final }));
        }
      } finally { await handle.close(); }
    } catch (error) { if (!missing(error)) warning = "Saved worker result could not be read."; }
  }
  const retained = retain(entries); entries = retained.entries;
  const text = plainText(entries);
  return { taskId: options.taskId, text: text.slice(-MAX_TEXT), entries, truncated: truncated || retained.truncated || text.length > MAX_TEXT,
    ...(warning ? { warning } : {}) };
}
