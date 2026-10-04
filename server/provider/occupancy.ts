/** One wake source's reported state: how many background things it still has open. */
export type WakeSnapshot = {
  source: string;
  activeCount: number;
  items?: { id: string; description?: string }[];
};

export type OccupancyFlags = {
  isStreaming?: boolean;
  isBashRunning?: boolean;
  isCompacting?: boolean;
  pendingMessageCount?: number;
  retryAttempt?: number;
  queuedInputs?: number;
};

export type OccupancyInput = {
  wakes: readonly WakeSnapshot[];
  flags: OccupancyFlags;
  openTasks: number;
  openWorkpoolItems: number;
  openDagRuns: number;
  openMonitors: number;
  /** Open ask-user questions. The wake event for those is not on the RPC wire. */
  openQuestions: number;
  /** Background bash sessions read from the terminal sidecar. */
  openBashSessions: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseItems(value: unknown): WakeSnapshot["items"] {
  if (!Array.isArray(value)) return undefined;
  const items: { id: string; description?: string }[] = [];
  for (const raw of value) {
    if (!isRecord(raw) || typeof raw.id !== "string" || raw.id === "") continue;
    items.push(
      typeof raw.description === "string"
        ? { id: raw.id, description: raw.description }
        : { id: raw.id },
    );
  }
  return items;
}

/**
 * Folds one `wake_source_state` extension event into the per-source map.
 * Malformed events leave the map's contents unchanged; the input is never mutated.
 */
export function foldWakeEvent(
  current: ReadonlyMap<string, WakeSnapshot>,
  event: { type?: string; name?: string; data?: unknown },
): Map<string, WakeSnapshot> {
  const next = new Map(current);
  if (event.type !== "extension_event" || event.name !== "wake_source_state") return next;
  const data = event.data;
  if (!isRecord(data)) return next;
  const { source, activeCount } = data;
  if (typeof source !== "string" || source === "") return next;
  if (typeof activeCount !== "number" || !Number.isFinite(activeCount)) return next;
  if (activeCount <= 0) {
    next.delete(source);
    return next;
  }
  const items = parseItems(data.items);
  next.set(source, items ? { source, activeCount, items } : { source, activeCount });
  return next;
}

/** True while anything in the session still has background work in flight. */
export function isOccupied(input: OccupancyInput): boolean {
  const { flags } = input;
  return (
    input.wakes.some((wake) => wake.activeCount > 0) ||
    flags.isStreaming === true ||
    flags.isBashRunning === true ||
    flags.isCompacting === true ||
    (flags.pendingMessageCount ?? 0) > 0 ||
    (flags.retryAttempt ?? 0) > 0 ||
    (flags.queuedInputs ?? 0) > 0 ||
    input.openTasks > 0 ||
    input.openWorkpoolItems > 0 ||
    input.openDagRuns > 0 ||
    input.openMonitors > 0 ||
    input.openQuestions > 0 ||
    input.openBashSessions > 0
  );
}
