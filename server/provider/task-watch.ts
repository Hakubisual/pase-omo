import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ProviderEvent } from "@getpaseo/plugin/server/provider";

/**
 * `task()` runs, surfaced as the child sessions Paseo already knows how to draw.
 *
 * OmO records every spawned task under `<cwd>/.omo/senpi-task/tasks/st_*.json`
 * with the parent session it belongs to, but nothing read those files, so a
 * subagent run left only a flat tool-call row: no status, no link, and nothing
 * at all once the row scrolled away. A provider may announce a child session by
 * emitting `session.opened` with `parentSessionId`; the daemon turns that into
 * the `provider_subagent` upserts behind the subagent panel and the agent
 * tracks, and `session.turn` on that child carries its status.
 *
 * Everything below the file read is a pure decision, so the interesting part -
 * what a record means the first time it is seen, and what a status change means
 * afterwards - is tested without a clock or a disk.
 */

export const TASKS_DIR_SEGMENTS = [".omo", "senpi-task", "tasks"] as const;

export interface TaskRecord {
  task_id: string;
  status?: string;
  parent_session_id?: string;
  root_session_id?: string;
  task_summary?: string;
  description?: string;
  category?: string;
  model?: string;
  started_at?: string;
  terminal_at?: string;
}

/** What the watcher already told the host about one task. */
export interface TaskState {
  status: string;
  opened: boolean;
  closed: boolean;
}

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "complete",
  "done",
  "error",
  "failed",
  "cancelled",
  "canceled",
]);

export function isTerminalTask(record: TaskRecord): boolean {
  if (typeof record.terminal_at === "string" && record.terminal_at.length > 0) return true;
  return TERMINAL_STATUSES.has((record.status ?? "").toLowerCase());
}

function failed(record: TaskRecord): boolean {
  const status = (record.status ?? "").toLowerCase();
  return status === "error" || status === "failed";
}

/** The line the child's own timeline opens with: what was asked, and of whom. */
export function taskSummaryLine(record: TaskRecord): string {
  const parts: string[] = [];
  const headline = record.task_summary ?? record.description;
  if (headline) parts.push(headline);
  const attributes: string[] = [];
  if (record.category) attributes.push(record.category);
  if (record.model) attributes.push(record.model);
  if (attributes.length > 0) parts.push(`(${attributes.join(" · ")})`);
  return parts.length > 0 ? parts.join(" ") : record.task_id;
}

export function taskTitle(record: TaskRecord): string {
  return record.description ?? record.task_summary ?? record.task_id;
}

export interface ChildEventInput {
  record: TaskRecord;
  /** Session id the host knows this provider by, which the child hangs under. */
  parentSessionId: string;
  cwd: string;
  previous: TaskState | undefined;
}

export interface ChildEventResult {
  events: ProviderEvent[];
  state: TaskState;
}

/**
 * The events one record produces, given what was already published for it.
 *
 * A task first seen in a terminal state still opens before it closes: the panel
 * row is how the run is reachable at all, and a run that finished while nobody
 * was watching is exactly the one worth keeping.
 */
export function taskChildEvents({ record, parentSessionId, cwd, previous }: ChildEventInput): ChildEventResult {
  const status = (record.status ?? "running").toLowerCase();
  const sessionId = record.task_id;
  const events: ProviderEvent[] = [];
  const state: TaskState = {
    status,
    opened: previous?.opened ?? false,
    closed: previous?.closed ?? false,
  };

  if (state.closed) return { events, state };

  if (!state.opened) {
    events.push({
      type: "session.opened",
      sessionId,
      parentSessionId,
      capabilities: [],
      restoration: "core",
      title: taskTitle(record),
      description: taskSummaryLine(record),
      cwd,
    });
    events.push({
      type: "timeline.item",
      sessionId,
      item: { type: "assistant_message", id: `${sessionId}-summary`, text: taskSummaryLine(record) },
    });
    events.push({ type: "session.turn", sessionId, turnId: `${sessionId}-run`, state: "started" });
    state.opened = true;
  } else if (previous !== undefined && previous.status === status) {
    // Nothing moved, so nothing is said: every event here is another row.
    return { events, state };
  }

  if (!isTerminalTask(record)) return { events, state };

  events.push({
    type: "timeline.item",
    sessionId,
    item: {
      type: "assistant_message",
      id: `${sessionId}-result`,
      text: failed(record) ? `Task failed (${status})` : `Task ${status}`,
    },
  });
  events.push({
    type: "session.turn",
    sessionId,
    turnId: `${sessionId}-run`,
    state: failed(record) ? "failed" : "completed",
    ...(failed(record) ? { error: { message: `Task ${status}` } } : {}),
  });
  events.push({ type: "session.closed", sessionId });
  state.closed = true;
  return { events, state };
}

export function tasksDirectory(cwd: string): string {
  return join(cwd, ...TASKS_DIR_SEGMENTS);
}

/** Reads the task records this OmO session spawned. Missing directory = none. */
export async function readTaskRecords(cwd: string, omoSessionId: string): Promise<TaskRecord[]> {
  let names: string[];
  try {
    names = await readdir(tasksDirectory(cwd));
  } catch {
    return [];
  }
  const records: TaskRecord[] = [];
  for (const name of names) {
    if (!name.startsWith("st_") || !name.endsWith(".json")) continue;
    try {
      const parsed: unknown = JSON.parse(await readFile(join(tasksDirectory(cwd), name), "utf8"));
      if (typeof parsed !== "object" || parsed === null) continue;
      const record = parsed as TaskRecord;
      if (typeof record.task_id !== "string" || record.task_id.length === 0) continue;
      // Only this session's children: the directory is shared by every session
      // that has ever run in this project.
      if (record.parent_session_id !== omoSessionId) continue;
      records.push(record);
    } catch {
      // A record being written right now is read again on the next pass.
      continue;
    }
  }
  return records;
}
