import { appendFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { readWorkerOutput } from "./worker-output.js";
import { workerOutputRpc } from "../../shared/dag.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dag-output-")); roots.push(root);
  const cwd = join(root, "project"), store = join(root, "state"), sessions = join(root, "sessions");
  const dir = join(store, "children/st_worker/sessions/st_worker");
  for (const p of [cwd, sessions, join(store, "tasks"), dir]) await mkdir(p, { recursive: true });
  await writeFile(join(sessions, "parent.jsonl"), JSON.stringify({ type: "session", id: "parent", cwd, timestamp: "2026-10-19T00:00:00Z" }) + "\n");
  const task = { task_id: "st_worker", parent_session_id: "parent", status: "running", spawn_spec: { cwd, prompt: "PRIVATE PROMPT" } };
  const taskFile = join(store, "tasks/st_worker.json"); await writeFile(taskFile, JSON.stringify(task));
  const file = join(dir, "2026-worker.jsonl");
  const read = () => readWorkerOutput({ cwd, taskStateDir: store, sessionsDir: sessions, sessionId: "parent", taskId: "st_worker" });
  return { root, cwd, store, sessions, file, task, taskFile, read };
}
const entry = (role: string, content: unknown, extra = {}) => JSON.stringify({ type: "message", message: { role, content, ...extra } }) + "\n";

test("output reads only visible worker text, tool names and results without changing worker state", async () => {
  const f = await fixture();
  await writeFile(f.file, entry("user", "PRIVATE USER") + entry("assistant", [
    { type: "thinking", thinking: "PRIVATE REASONING" }, { type: "text", text: "PRIVATE INJECTION", audience: "model" },
    { type: "text", text: "PRIVATE HIDDEN", display: false }, { type: "text", text: "First output" },
    { type: "toolCall", name: "read", arguments: { secret: "PRIVATE ARGS" } },
    { type: "text", text: "<memory_notice>PRIVATE MEMORY</memory_notice>Visible tail" },
  ]) + entry("toolResult", [{ type: "text", text: "Tool output" }]) + entry("assistant", "PRIVATE MESSAGE", { audience: "model" }));
  const before = await readFile(f.taskFile, "utf8");
  expect(await f.read()).toMatchObject({ text: "First output\n\nTool: read\n\nVisible tail\n\nTool result: Tool output", truncated: false });
  expect((await f.read()).text).not.toContain("PRIVATE");
  expect(await readFile(f.taskFile, "utf8")).toBe(before);
});

test("a reconnect-style fresh read is stable and includes subsequent output once", async () => {
  const f = await fixture(); await writeFile(f.file, entry("assistant", "First"));
  expect(await f.read()).toEqual(await f.read());
  await appendFile(f.file, entry("assistant", "After reconnect"));
  const result = await f.read(); expect(result.text).toBe("First\n\nAfter reconnect");
  expect(await f.read()).toEqual(result);
});

test("scope and task IDs are validated before output reads", async () => {
  const f = await fixture(); await writeFile(f.file, entry("assistant", "PRIVATE"));
  await expect(readWorkerOutput({ cwd: f.cwd, sessionsDir: f.sessions, taskStateDir: f.store, sessionId: "foreign", taskId: "st_worker" })).rejects.toThrow();
  await expect(readWorkerOutput({ cwd: f.cwd, sessionsDir: f.sessions, taskStateDir: f.store, sessionId: "parent", taskId: "st_other" })).rejects.toThrow("belong");
  expect(workerOutputRpc.input.safeParse({ cwd: f.cwd, sessionId: "parent", taskId: "../st_worker" }).success).toBe(false);
  expect(workerOutputRpc.input.safeParse({ taskId: "st_worker" }).success).toBe(false);
});

test("missing transcripts fall back to a retained final response", async () => {
  const f = await fixture(); expect((await f.read()).text).toBe("");
  await writeFile(f.taskFile, JSON.stringify({ ...f.task, status: "completed", final_response: "Saved final", terminal_at: "2026-10-19T00:01:00Z" }));
  expect(await f.read()).toMatchObject({ text: "Saved final", truncated: false });
});

test("partial lines wait for completion, malformed lines are visible and the result is bounded", async () => {
  const f = await fixture(); await writeFile(f.file, 'bad json\n' + entry("assistant", "x".repeat(300_000)) + entry("assistant", "Recent") + '{"type":"message"');
  const result = await f.read(); expect(result.truncated).toBe(true); expect(result.text.length).toBeLessThanOrEqual(24_000); expect(result.text).toContain("Recent");
  expect(result.text).not.toContain('"type"');
  await writeFile(f.file, 'bad json\n' + entry("assistant", "Still visible"));
  expect(await f.read()).toMatchObject({ text: "Still visible", warning: expect.stringMatching(/entries/) });
});

test("symlinked output directories cannot read data outside the selected store", async () => {
  const f = await fixture(), outside = join(f.root, "outside"); await mkdir(outside);
  await writeFile(join(outside, "secret.jsonl"), entry("assistant", "PRIVATE OUTSIDE"));
  await rm(join(f.store, "children"), { recursive: true }); await symlink(outside, join(f.store, "children"));
  const result = await f.read(); expect(result.text).toBe(""); expect(result.warning).toMatch(/could not be read/);
});

test("a terminal saved result is shown even before the last transcript line lands, without duplication", async () => {
  const f = await fixture(); await writeFile(f.file, entry("assistant", "Working"));
  await writeFile(f.taskFile, JSON.stringify({ ...f.task, status: "completed", final_response: "Final result", terminal_at: "2026-10-19T00:01:00Z" }));
  expect((await f.read()).text).toBe("Working\n\nFinal result");
  await appendFile(f.file, entry("assistant", "Final result"));
  expect((await f.read()).text).toBe("Working\n\nFinal result");
});

test("old matching text outside the retained excerpt cannot hide the saved final result", async () => {
  const f = await fixture(); await writeFile(f.file, entry("assistant", "Final answer") + entry("assistant", "x".repeat(25_000)));
  await writeFile(f.taskFile, JSON.stringify({ ...f.task, status: "completed", final_response: "Final answer" }));
  const result = await f.read(); expect(result.truncated).toBe(true); expect(result.text.endsWith("Final answer")).toBe(true);
});

test("assistant and tool output retain structure instead of becoming one raw text block", async () => {
  const f = await fixture();
  await writeFile(f.file, entry("assistant", [
    { type: "text", text: "**Checking** the implementation." },
    { type: "toolCall", id: "call-grep", name: "grep", arguments: { secret: "PRIVATE ARGS" } },
  ]) + entry("toolResult", [{ type: "text", text: "42-  def handler():\n43-      return True\n[grep: matches=1]" }], { toolCallId: "call-grep", toolName: "grep", isError: false })
    + entry("assistant", [{ type: "text", text: "The check passed." }]));
  const result = await f.read();
  expect(result).toHaveProperty("entries");
  expect(result.entries).toEqual([
    expect.objectContaining({ type: "assistant", text: "**Checking** the implementation." }),
    expect.objectContaining({ type: "tool_call", toolName: "grep", toolCallId: "call-grep" }),
    expect.objectContaining({ type: "tool_result", toolName: "grep", toolCallId: "call-grep", isError: false, text: expect.stringContaining("42-") }),
    expect.objectContaining({ type: "assistant", text: "The check passed." }),
  ]);
  expect(JSON.stringify(result)).not.toContain("PRIVATE ARGS");
});

test("structured IDs survive append and reconnect reads, and retained entries remain bounded", async () => {
  const f = await fixture(); await writeFile(f.file, entry("assistant", "Original"));
  const first = await f.read();
  await appendFile(f.file, entry("toolResult", [{ type: "text", text: "code\n".repeat(3000) }], { toolCallId: "call-x", toolName: "eval", isError: true }));
  const second = await f.read();
  expect(second.entries?.[0]?.id).toBe(first.entries?.[0]?.id);
  expect(second.entries?.[1]).toMatchObject({ type: "tool_result", isError: true, truncated: true });
  expect(second.entries?.[1]?.text.length).toBeLessThanOrEqual(8000);
  expect(second).toEqual(await f.read());
  await writeFile(f.file, Array.from({ length: 120 }, (_, i) => entry("assistant", `Message ${i}`)).join(""));
  const limited = await f.read();expect(limited.entries).toHaveLength(80);expect(limited.truncated).toBe(true);
  expect(limited.entries?.[0]?.text).toBe("Message 40");
});

test("structured messages preserve privacy filtering and terminal final text exactly once", async () => {
  const f = await fixture();
  await writeFile(f.file, entry("assistant", [
    { type: "thinking", thinking: "PRIVATE" }, { type: "text", text: "PRIVATE", audience: "model" },
    { type: "text", text: "**Finished**" }, { type: "toolCall", id: "call-x", name: "read", arguments: { text: "PRIVATE" } },
  ]));
  await writeFile(f.taskFile, JSON.stringify({ ...f.task, status: "completed", final_response: "**Finished**" }));
  const result = await f.read();expect(JSON.stringify(result)).not.toContain("PRIVATE");
  expect(result.entries?.filter(e => e.text === "**Finished**")).toHaveLength(1);
  expect(result.entries?.at(-1)?.type).toBe("final");
});
