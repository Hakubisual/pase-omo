import type { PluginTheme } from "@getpaseo/plugin";
import { StyleSheet } from "react-native";

import type { TodoStatus, TodoRow } from "../shared/todo";

/**
 * The card only reads theme colors, so tests and future callers can supply a
 * bare color set instead of a full `PluginTheme`.
 */
export type TodoCardTheme = { readonly colors: PluginTheme["colors"] };

/** The part of the host layout the card reacts to: the phone form factor. */
export type TodoCardLayout = { readonly compact?: boolean | undefined };

export type EntryVisual = {
  /** A fixed-width text marker, so the list stays readable without colour. */
  marker: string;
  markerColor: string;
  textColor: string;
  backgroundColor: string;
  struck: boolean;
  /** The one task in flight is tinted and brightened, so it reads as switched on. */
  lit: boolean;
  /** Spoken status for the row's accessibility label. */
  spoken: string;
};

const SPOKEN: Record<TodoStatus, string> = {
  completed: "Done",
  in_progress: "In progress",
  pending: "Pending",
};

/** One drawn row of the card, with the pieces the view needs pre-resolved. */
export type TodoRowVisual = {
  id: string;
  text: string;
  /** Key for the row element, so a streaming flip keeps the same mounted row. */
  key: string;
  visual: EntryVisual;
  /** The accent line is shown only for the row actually in flight. */
  showActiveForm: boolean;
  /** The in-flight wording from the payload, null when there is none. */
  activeForm: string | null;
  accessibilityLabel: string;
  /**
   * Line bounds in the compact phone layout: the ellipsis end of a bounded
   * block, so no label can push the card past the screen edge. Null on the
   * desktop layout, where the roomier card lets text wrap freely.
   */
  textLines: number | null;
  activeFormLines: number | null;
};

/** Everything the card draws, derived once so the component stays a shell. */
export type TodoCardModel = {
  /** Recounted from the rendered entries, never trusted from the payload. */
  total: number;
  completed: number;
  remaining: number;
  percent: number;
  allDone: boolean;
  streaming: boolean;
  /** True when the host handed down the phone form factor. */
  compact: boolean;
  badge: string;
  title: string;
  /** Line bound of the header title in compact, null on desktop. */
  titleLines: number | null;
  counter: string;
  footer: string | null;
  rows: TodoRowVisual[];
};

const BADGE = "TODO";
const FOOTER = "Working…";
const TITLE_ALL_DONE = "All done";
const titleRemaining = (remaining: number): string => `${remaining} left`;

/** Fixed width of the marker column ("[ ]"/"[•]"/"[✓]" plus breathing room). */
const MARKER_WIDTH = 24;

// --- Compact (390px phone) line budgeting ---------------------------------
//
// The card has no DOM to measure in tests, so line counts are estimated with
// deliberately wide glyph widths (1em per CJK glyph, 0.62em per latin one).
// Real text never measures wider than the estimate, so a label that fits the
// estimate within the 390px content box fits for real — and anything longer is
// line-bounded and truncates with an ellipsis instead of overflowing.

const COMPACT_LINE_BOUND = 2;

/** conservative single-line width estimate of `text` at `fontSize` */
function estimatedTextWidth(text: string, fontSize: number): number {
  let width = 0;
  for (const char of text) width += (char.codePointAt(0) ?? 0) > 0x2e80 ? fontSize : fontSize * 0.62;
  return width;
}

/** how many lines `text` needs at `fontSize` inside `maxWidth` (at least 1) */
function estimatedLines(text: string, fontSize: number, maxWidth: number): number {
  return Math.max(1, Math.ceil(estimatedTextWidth(text, fontSize) / maxWidth));
}

const clampLines = (lines: number): number => Math.min(COMPACT_LINE_BOUND, Math.max(1, lines));

/**
 * Derives the card's view model from one row.
 *
 * The header counts are recomputed from the entries themselves: a row can reach
 * the renderer through a path that did not recount (the daemon republishes the
 * latest payload it kept for an item), and a header that promises a count the
 * list does not show reads as a bug. Deriving the rows here also keeps the
 * component a shell, so a mid-stream status flip re-renders by construction —
 * the entries are the only input, and their stable ids keep React reconciling
 * rows in place instead of remounting them.
 *
 * With `layout.compact` (the host's phone form factor) every flexible label is
 * line-bounded so the card fits a 390px screen, and every drawn string is
 * precomputed here, so "is the label present" is testable without a DOM.
 */
export function todoCardModel(
  row: TodoRow,
  theme: TodoCardTheme,
  layout: TodoCardLayout = {},
): TodoCardModel {
  const completed = row.entries.filter((entry) => entry.status === "completed").length;
  const total = row.entries.length;
  const remaining = total - completed;
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
  const compact = layout.compact === true;
  const styles = createStyles(theme, compact);

  // Phone budget: content box minus the fixed-width marker column. The title
  // gets its own header line in compact, so its cell is the content box.
  const contentWidth = 390 - styles.card.padding * 2 - styles.card.borderWidth * 2;
  const bodyMaxWidth = contentWidth - MARKER_WIDTH - styles.body.gap - styles.row.paddingHorizontal * 2;
  const titleMaxWidth = contentWidth;

  return {
    total,
    completed,
    remaining,
    percent,
    allDone: total > 0 && completed === total,
    streaming: row.phase === "streaming",
    compact,
    badge: BADGE,
    title: remaining === 0 ? TITLE_ALL_DONE : titleRemaining(remaining),
    counter: `${completed}/${total}`,
    footer: row.phase === "streaming" ? FOOTER : null,
    rows: row.entries.map((entry) => {
      const visual = entryVisual(entry.status, theme);
      const showActiveForm = visual.lit && entry.activeForm !== undefined;
      const activeForm = entry.activeForm ?? null;
      return {
        id: entry.id,
        text: entry.text,
        key: entry.id,
        visual,
        showActiveForm,
        activeForm,
        accessibilityLabel: `${visual.spoken}, ${entry.text}`,
        textLines: compact ? clampLines(estimatedLines(entry.text, styles.text.fontSize, bodyMaxWidth)) : null,
        activeFormLines:
          compact && showActiveForm && activeForm !== null
            ? clampLines(estimatedLines(activeForm, styles.activeForm.fontSize, bodyMaxWidth))
            : null,
      };
    }),
    titleLines: compact ? clampLines(estimatedLines(remaining === 0 ? TITLE_ALL_DONE : titleRemaining(remaining), styles.title.fontSize, titleMaxWidth)) : null,
  };
}

/**
 * The card's stylesheet, owned here because the compact line budget in
 * `todoCardModel` is derived from these exact values — the styles and the
 * budget cannot drift apart the way two separately owned copies would.
 *
 * Compact is the phone form factor: the header stacks vertically instead of
 * squeezing onto one row, type steps up a notch for arm's-length reading, and
 * rows grow to a 44px touch target.
 */
export function createStyles(theme: TodoCardTheme, compact: boolean) {
  return StyleSheet.create({
    card: {
      backgroundColor: theme.colors.surface1,
      borderColor: theme.colors.border,
      borderWidth: 1,
      borderRadius: 12,
      padding: compact ? 12 : 16,
      gap: compact ? 8 : 10,
    },
    // Column on the phone: badge, title and counter each get a full line, so
    // the header never becomes a three-way squeeze at 390px.
    header: { flexDirection: compact ? "column" : "row", alignItems: "flex-start", gap: 8 },
    badge: {
      color: theme.colors.foregroundMuted,
      backgroundColor: theme.colors.surface2,
      borderRadius: 6,
      paddingHorizontal: 6,
      paddingVertical: 2,
      fontSize: 11,
    },
    title: { flex: compact ? 0 : 1, color: theme.colors.foreground, fontWeight: "600", fontSize: compact ? 15 : 14 },
    counter: { color: theme.colors.foregroundMuted, fontSize: 12, fontVariant: ["tabular-nums"] },
    track: { height: 4, borderRadius: 999, backgroundColor: theme.colors.surface2, overflow: "hidden" },
    fill: { height: 4, borderRadius: 999, backgroundColor: theme.colors.statusSuccess },
    list: { gap: 2 },
    row: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 6,
      paddingHorizontal: 6,
      // Vertical padding carries the 44px touch target on the phone.
      paddingVertical: compact ? 11 : 3,
      borderRadius: 6,
      minHeight: compact ? 44 : undefined,
    },
    marker: { fontSize: compact ? 12 : 11, lineHeight: 18, fontVariant: ["tabular-nums"] },
    body: { flex: 1, gap: 1 },
    text: { fontSize: compact ? 13 : 12, lineHeight: 18 },
    activeForm: { color: theme.colors.accent, fontSize: 11, lineHeight: 15 },
    footer: { color: theme.colors.foregroundMuted, fontSize: 11 },
  });
}

export function entryVisual(status: TodoStatus, theme: TodoCardTheme): EntryVisual {
  const base = { spoken: SPOKEN[status], backgroundColor: "transparent" };

  if (status === "completed") {
    return {
      ...base,
      marker: "[✓]",
      markerColor: theme.colors.statusSuccess,
      textColor: theme.colors.foregroundMuted,
      struck: true,
      lit: false,
    };
  }

  if (status === "in_progress") {
    return {
      ...base,
      marker: "[•]",
      markerColor: theme.colors.accent,
      textColor: theme.colors.foreground,
      // An 8-digit hex keeps the tint inside the theme's own accent.
      backgroundColor: `${theme.colors.accent}14`,
      struck: false,
      lit: true,
    };
  }

  return {
    ...base,
    marker: "[ ]",
    markerColor: theme.colors.foregroundMuted,
    textColor: theme.colors.foregroundMuted,
    struck: false,
    lit: false,
  };
}
