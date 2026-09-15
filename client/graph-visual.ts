import type { PluginTheme } from "@getpaseo/plugin";

/** Every run state the DAG store can report. */
export const DAG_STATES = [
  "pending",
  "blocked",
  "scheduled",
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
  "skipped",
] as const;

const LABELS: Record<string, string> = {
  completed: "Done",
  running: "Running",
  failed: "Failed",
  cancelled: "Cancelled",
  skipped: "Skipped",
  blocked: "Blocked",
  scheduled: "Scheduled",
  paused: "Paused",
  pending: "Pending",
};

/**
 * Only a state that genuinely changes the outcome earns a glyph. Waiting states
 * stay bare so the three that matter — done, running, broken — are findable at a
 * glance instead of competing with decoration.
 */
const GLYPHS: Record<string, string> = {
  completed: "✓",
  running: "◌",
  failed: "!",
};

/** Waiting-but-held states read as warnings; plain waiting states stay neutral. */
const HELD = new Set(["blocked", "scheduled", "paused"]);

export function statusLabel(status: string): string {
  return LABELS[status] ?? status;
}

export function stateColor(state: string, theme: PluginTheme): string {
  if (state === "completed") return theme.colors.statusSuccess;
  if (state === "running") return theme.colors.accent;
  if (state === "failed") return theme.colors.statusDanger;
  if (HELD.has(state)) return theme.colors.statusWarning;
  return theme.colors.foregroundMuted;
}

export type NodeVisual = {
  label: string;
  glyph: string;
  borderColor: string;
  backgroundColor: string;
  labelColor: string;
  /** The running node is tinted and accented, so a live step reads as switched on. */
  lit: boolean;
};

export function nodeVisual(state: string, theme: PluginTheme): NodeVisual {
  const lit = state === "running";
  const loud = lit || state === "completed" || state === "failed";

  const borderColor =
    state === "completed"
      ? theme.colors.statusSuccess
      : lit
        ? theme.colors.accent
        : state === "failed"
          ? theme.colors.statusDanger
          : HELD.has(state)
            ? theme.colors.statusWarning
            : theme.colors.border;

  return {
    label: statusLabel(state),
    glyph: GLYPHS[state] ?? "",
    borderColor,
    // An 8-digit hex is a plain colour string, so the tint still comes from the
    // theme and follows it into every palette.
    backgroundColor: lit ? `${theme.colors.accent}1f` : theme.colors.surface2,
    labelColor: loud ? theme.colors.foreground : theme.colors.foregroundMuted,
    lit,
  };
}

/** Type sizes for the three strings a node draws. */
export type GraphTypography = { glyph: number; label: number; state: number };

/**
 * Smallest type the card will draw.
 *
 * A scaled-down graph shrinks its boxes, and type that rode the same factor
 * down turned a fitted graph into an unreadable one. The floor is what the
 * scale is allowed to cost: below it the type stops shrinking, and the node
 * content sheds a line instead (`fitsStateLine`).
 */
const TYPE_FLOOR: GraphTypography = { glyph: 9, label: 10, state: 9 };

/**
 * How far a graph may shrink to fit a narrow box before shrinking stops paying.
 *
 * Both graph surfaces - the chat card and the panel's canvas - answer to this
 * one number, because it is a statement about reading, not about either
 * layout: past it the node box is too short to hold floored type, so the graph
 * keeps its size and scrolls instead.
 */
export const READABLE_MIN_SCALE = 0.58;

const TYPE_BASE: Record<"compact" | "roomy", GraphTypography> = {
  compact: { glyph: 11, label: 12, state: 10 },
  roomy: { glyph: 12, label: 13, state: 11 },
};

/** Type sizes for a graph drawn at `scale`, never smaller than the floor. */
export function graphTypography(scale: number, compact: boolean): GraphTypography {
  const base = TYPE_BASE[compact ? "compact" : "roomy"];
  return {
    glyph: Math.max(TYPE_FLOOR.glyph, Math.round(base.glyph * scale)),
    label: Math.max(TYPE_FLOOR.label, Math.round(base.label * scale)),
    state: Math.max(TYPE_FLOOR.state, Math.round(base.state * scale)),
  };
}

/**
 * Whether a node this tall can hold its state line under its label.
 *
 * When it cannot, the label wins: the state is already carried by the node's
 * colour and border, so dropping the word costs nothing a glance can see, while
 * a clipped label costs the only thing that names the node.
 */
export function fitsStateLine(nodeHeight: number, type: GraphTypography): boolean {
  return nodeHeight >= Math.round(type.label * 1.3) + Math.round(type.state * 1.3) + 12;
}

export type EdgeVisual = { color: string; thickness: number };

/**
 * A dependency is satisfied by its SOURCE completing, not by the destination
 * doing anything, so the arrow into a queued node still turns green once the
 * thing it waits on is done.
 */
export function edgeVisual(fulfilled: boolean, theme: PluginTheme): EdgeVisual {
  return fulfilled ? { color: theme.colors.statusSuccess, thickness: 2 } : { color: theme.colors.border, thickness: 1 };
}

export function progressPercent(row: { completed: number; total: number }): number {
  return row.total > 0 ? Math.round((row.completed / row.total) * 100) : 0;
}

export type NodeTransitionFrame = { opacity: number; scale: number };

export type NodeTransition = {
  animate: boolean;
  durationMs: number;
  from: NodeTransitionFrame;
  to: NodeTransitionFrame;
  emphasis: "none" | "enter" | "change" | "alert";
};

const STILL: NodeTransitionFrame = { opacity: 1, scale: 1 };

/**
 * Describes the animation a node plays when its state changes.
 *
 * The renderer drives Animated from this single description instead of
 * branching on states itself, so "what a change looks like" stays one testable
 * decision rather than a handful of conditionals spread through JSX. A node
 * that did not change animates nothing: re-playing an animation on every
 * unrelated re-render is what makes a live graph look broken.
 */
export function nodeTransition(previous: string | undefined, next: string): NodeTransition {
  if (previous === undefined) {
    // First paint: fade the node in rather than letting it pop.
    return {
      animate: true,
      durationMs: 220,
      from: { opacity: 0.35, scale: 0.94 },
      to: STILL,
      emphasis: "enter",
    };
  }

  if (previous === next) {
    return { animate: false, durationMs: 0, from: STILL, to: STILL, emphasis: "none" };
  }

  if (next === "failed") {
    return {
      animate: true,
      durationMs: 260,
      from: { opacity: 0.5, scale: 1.06 },
      to: STILL,
      emphasis: "alert",
    };
  }

  // Everything else - queued to running, running to completed - settles INTO
  // place: growing reads as progress where shrinking reads as removal.
  return {
    animate: true,
    durationMs: 240,
    from: { opacity: 0.55, scale: 0.96 },
    to: STILL,
    emphasis: "change",
  };
}
