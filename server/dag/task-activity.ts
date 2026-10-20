import { open } from "node:fs/promises";
import { join } from "node:path";

export interface TaskActivity {
  observedToolCalls: number;
  lastTool?: string;
  lastActivityAt?: string;
  activityError?: string;
}
interface Cursor {
  inode: number; offset: number; pending: Buffer; prefix: Buffer; discarding: boolean;
  observedToolCalls: number; lastTool?: string; lastActivityAt?: string; invalid: boolean;
}
const MAX_LINE = 256 * 1024;
const MAX_READ = 1024 * 1024;

/** Returns metadata only; bounded raw fragments are retained solely for incremental parsing. */
export class TaskActivityReader {
  private readonly cursors = new Map<string, Cursor>();
  private readonly pendingReads = new Map<string, Promise<TaskActivity | undefined>>();

  read(store: string, taskId: string): Promise<TaskActivity | undefined> {
    if (!/^st_[A-Za-z0-9_-]{1,253}$/.test(taskId)) return Promise.resolve(undefined);
    const file = join(store, "logs", `${taskId}.jsonl`);
    const pending = this.pendingReads.get(file);
    if (pending) return pending;
    const read = this.readFile(file).finally(() => this.pendingReads.delete(file));
    this.pendingReads.set(file, read);
    return read;
  }

  private async readFile(file: string): Promise<TaskActivity | undefined> {
    let handle;
    try { handle = await open(file, "r"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") { this.cursors.delete(file); return undefined; }
      return { observedToolCalls: 0, activityError: "Worker activity could not be read." };
    }
    try {
      const stat = await handle.stat();
      const prefix = Buffer.alloc(Math.min(128, stat.size));
      await handle.read(prefix, 0, prefix.length, 0);
      let cursor = this.cursors.get(file);
      if (!cursor || cursor.inode !== stat.ino || stat.size < cursor.offset || !prefix.subarray(0, cursor.prefix.length).equals(cursor.prefix)) {
        cursor = { inode: stat.ino, offset: 0, prefix, pending: Buffer.alloc(0), discarding: false, observedToolCalls: 0, invalid: false };
      }
      cursor.prefix = prefix;
      this.cursors.delete(file); this.cursors.set(file, cursor);
      // Bounded cache and per-poll read budget, even with many long-running tasks.
      while (this.cursors.size > 128) this.cursors.delete(this.cursors.keys().next().value!);
      const end = Math.min(stat.size, cursor.offset + MAX_READ);
      while (cursor.offset < end) {
        const buffer = Buffer.alloc(Math.min(65536, end - cursor.offset));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, cursor.offset);
        if (!bytesRead) break;
        cursor.offset += bytesRead;
        const bytes = Buffer.concat([cursor.pending, buffer.subarray(0, bytesRead)]);
        let start = 0;
        for (let newline = bytes.indexOf(10); newline >= 0; newline = bytes.indexOf(10, start)) {
          const line = bytes.subarray(start, newline); start = newline + 1;
          if (!cursor.discarding && line.length <= MAX_LINE && line.toString("utf8").trim()) {
            try {
              const entry = JSON.parse(line.toString("utf8"));
              if (entry?.type === "tool_execution" && typeof entry.payload?.tool === "string") {
                cursor.observedToolCalls += 1;
                cursor.lastTool = entry.payload.tool.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ").slice(0, 128);
              }
            } catch { cursor.invalid = true; }
          } else if (line.length > MAX_LINE) cursor.invalid = true;
          cursor.discarding = false;
        }
        cursor.pending = Buffer.from(bytes.subarray(start));
        if (cursor.pending.length > MAX_LINE || cursor.discarding) {
          cursor.pending = Buffer.alloc(0); cursor.discarding = true; cursor.invalid = true;
        }
      }
      // File mtime is a recorded-activity timestamp, not a claim that a tool is currently running.
      if (stat.size > 0) cursor.lastActivityAt = stat.mtime.toISOString();
      return {
        observedToolCalls: cursor.observedToolCalls,
        ...(cursor.lastTool ? { lastTool: cursor.lastTool } : {}),
        ...(cursor.lastActivityAt ? { lastActivityAt: cursor.lastActivityAt } : {}),
        ...(cursor.invalid || cursor.offset < stat.size ? { activityError: "Activity summary is partial; observed counts may be incomplete." } : {}),
      };
    } catch { return { observedToolCalls: 0, activityError: "Worker activity could not be read." }; }
    finally { await handle.close(); }
  }
}
