import { sameCwd } from "../provider/omo-store.js";

type Json = Record<string, unknown>;

const MAX_SESSIONS = 128;
const MAX_TASKS = 1024;
const MAX_EVENT_TASKS = 256;
const MAX_AGE_MS = 30 * 60 * 1000;
const TERMINAL = new Set(["completed", "error", "cancelled", "interrupted", "lost", "failed", "skipped"]);

interface Entry {
  raw: Json;
  receivedAt: number;
}
interface Session {
  cwd: string;
  parentSessionId: string;
  tasks: Map<string, Entry>;
}

function object(value: unknown): Json | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Json : undefined;
}

/** Retain only bounded DAG fields, never prompts, tool arguments or final responses. */
function projection(value: unknown): (Json & { task_id: string }) | undefined {
  const source = object(value);
  if (!source || typeof source.task_id !== "string" || !/^st_[A-Za-z0-9_-]{1,253}$/.test(source.task_id)) return;
  if (typeof source.status !== "string" || !source.status || source.status.length > 64) return;
  const raw: Json & { task_id: string } = { task_id: source.task_id, status: source.status };
  for (const key of ["description", "task_summary", "name", "agent_type", "category", "model", "child_session_id"]) {
    if (typeof source[key] === "string") raw[key] = source[key].slice(0, 2000);
  }
  for (const key of ["created_at", "started_at", "updated_at", "terminal_at"]) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value) || typeof value === "string" && value.length <= 64) raw[key] = value;
  }
  const stats = object(source.run_stats);
  const runStats: Json = {};
  for (const key of ["turns", "tool_calls"]) {
    const value = stats?.[key];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) runStats[key] = value;
  }
  if (Object.keys(runStats).length > 0) raw.run_stats = runStats;
  const live = object(source.live_progress);
  // Terminal snapshots sometimes still carry the last child event. Never let
  // those transient counters override final run_stats or retain live text.
  if (live && !TERMINAL.has(source.status)) {
    const progress: Json = {};
    for (const key of ["activity", "current_tool", "last_assistant_line"]) {
      if (typeof live[key] === "string") progress[key] = live[key].slice(0, 512);
    }
    const started = live.started_at;
    if (typeof started === "number" && Number.isFinite(started) || typeof started === "string" && started.length <= 64) progress.started_at = started;
    for (const key of ["turns", "tool_calls"]) {
      const value = live[key];
      if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) progress[key] = value;
    }
    raw.live_progress = progress;
  }
  return raw;
}

/** Ephemeral overlays are scoped to a provider instance AND its durable owner. */
export class LiveTaskStore {
  private readonly sessions = new Map<symbol, Session>();

  clear(owner: symbol): void { this.sessions.delete(owner); }

  private prune(now: number): void {
    for (const [owner, session] of this.sessions) {
      for (const [id, entry] of session.tasks) {
        if (now - entry.receivedAt >= MAX_AGE_MS) session.tasks.delete(id);
      }
      if (session.tasks.size === 0) this.sessions.delete(owner);
    }
  }

  update(owner: symbol, cwd: string, parentSessionId: string, data: unknown): void {
    const envelope = object(data);
    if (!parentSessionId || envelope?.parent_session_id !== parentSessionId || !Array.isArray(envelope.tasks)) return;
    const now = Date.now();
    this.prune(now);
    let session = this.sessions.get(owner);
    if (!session || session.parentSessionId !== parentSessionId || !sameCwd(session.cwd, cwd)) {
      session = { cwd, parentSessionId, tasks: new Map() };
    }
    // Events are capped snapshots, not a deletion protocol. Omitted tasks live
    // until expiry/teardown; their durable records are always the fallback.
    for (const value of envelope.tasks.slice(0, MAX_EVENT_TASKS)) {
      const raw = projection(value);
      if (!raw) continue;
      const id = raw.task_id;
      session.tasks.delete(id);
      session.tasks.set(id, { raw, receivedAt: now });
      if (session.tasks.size > MAX_TASKS) {
        const oldest = session.tasks.keys().next();
        if (!oldest.done) session.tasks.delete(oldest.value);
      }
    }
    if (session.tasks.size === 0) return;
    this.sessions.delete(owner);
    this.sessions.set(owner, session);
    if (this.sessions.size > MAX_SESSIONS) {
      const oldest = this.sessions.keys().next();
      if (!oldest.done) this.sessions.delete(oldest.value);
    }
  }

  records(cwd: string): Array<{ parentSessionId: string; raw: Json; receivedAt: number }> {
    this.prune(Date.now());
    const records: Array<{ parentSessionId: string; raw: Json; receivedAt: number }> = [];
    for (const session of this.sessions.values()) {
      if (!sameCwd(session.cwd, cwd)) continue;
      for (const { raw, receivedAt } of session.tasks.values()) records.push({ parentSessionId: session.parentSessionId, raw, receivedAt });
    }
    return records;
  }
}

export const liveTasks = new LiveTaskStore();
