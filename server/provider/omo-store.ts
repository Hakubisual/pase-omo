import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** OmO's agent directory, where sessions and the RPC socket live. */
export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.OMO_CODING_AGENT_DIR || env.SENPI_CODING_AGENT_DIR || join(homedir(), ".omo", "agent");
}

export function sessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(agentDir(env), "sessions");
}

export interface SessionHeader {
  /** Durable session id from the JSONL header record. */
  id: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  /** True when this session was spawned by another session. */
  child: boolean;
  file: string;
  name?: string;
}

const pathKey = (value: string): string => (process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value));

export function sameCwd(a: string | undefined, b: string | undefined): boolean {
  if (!a?.trim() || !b?.trim()) return false;
  return pathKey(a) === pathKey(b);
}

function iso(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

async function directoryEntries(directory: string) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return [];
    throw error;
  }
}

/**
 * Read only the first JSONL record of a session file.
 *
 * Conversation content is never loaded: the header carries id, cwd and
 * timestamp, and the file's mtime carries recency.
 */
export async function readSessionHeader(file: string): Promise<SessionHeader | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(file, "r");
    const chunks: Buffer[] = [];
    let length = 0;
    while (length < 65_536) {
      const buffer = Buffer.alloc(Math.min(4096, 65_536 - length));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      const newline = buffer.subarray(0, bytesRead).indexOf(10);
      chunks.push(buffer.subarray(0, newline < 0 ? bytesRead : newline));
      length += bytesRead;
      if (newline >= 0) break;
    }
    const header = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    if (header.type !== "session") return undefined;
    if (typeof header.id !== "string" || typeof header.cwd !== "string") return undefined;
    const created = iso(header.timestamp);
    if (!created) return undefined;
    const info = await handle.stat();
    return {
      id: header.id,
      cwd: resolve(header.cwd),
      createdAt: created,
      updatedAt: info.mtime.toISOString(),
      child: typeof header.parentSession === "string" && header.parentSession.trim().length > 0,
      file,
      ...(typeof header.name === "string" && header.name.trim() ? { name: header.name } : {}),
    };
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

/** Enumerate `sessions/<cwd bucket>/<timestamp>_<id>.jsonl`, one level deep. */
export async function readSessionHeaders(directory: string): Promise<SessionHeader[]> {
  const entries = await directoryEntries(directory);
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const child of await directoryEntries(path)) {
        if (!child.isDirectory() && child.name.endsWith(".jsonl")) files.push(join(path, child.name));
      }
      continue;
    }
    if (entry.name.endsWith(".jsonl")) files.push(path);
  }
  const headers = await Promise.all(files.map(readSessionHeader));
  return headers.filter((header): header is SessionHeader => header !== undefined);
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
