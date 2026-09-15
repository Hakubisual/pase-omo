import type { PluginTheme } from "@getpaseo/plugin";
import { StyleSheet } from "react-native";

import type { WrapRow } from "../shared/wrap";

export type WrapCardTheme = {
  readonly colors: Pick<
    PluginTheme["colors"],
    "surface1" | "surface2" | "border" | "foreground" | "foregroundMuted"
  >;
};
export type WrapCardLayout = { readonly compact?: boolean | undefined };

export type WrapCardModel = {
  badge: string;
  summary: string;
  compact: boolean;
  accessibilityLabel: string;
  /** Line bound on the phone so a long summary wraps then ellipsises. Null on desktop. */
  summaryLines: number | null;
};

const COMPACT_LINE_BOUND = 3;

function estimatedTextWidth(text: string, fontSize: number): number {
  let width = 0;
  for (const char of text) width += (char.codePointAt(0) ?? 0) > 0x2e80 ? fontSize : fontSize * 0.62;
  return width;
}

function estimatedLines(text: string, fontSize: number, maxWidth: number): number {
  return Math.max(1, Math.ceil(estimatedTextWidth(text, fontSize) / maxWidth));
}

const clampLines = (lines: number): number => Math.min(COMPACT_LINE_BOUND, Math.max(1, lines));

/**
 * Compact usage-bar model: badge plus wrapping summary, the same shape as the
 * TUI "TPS … Cache hit …" strip. Counts and line bounds are derived here so the
 * view stays a shell.
 */
export function wrapCardModel(row: WrapRow, theme: WrapCardTheme, layout: WrapCardLayout = {}): WrapCardModel {
  const compact = layout.compact === true;
  const styles = createWrapStyles(theme, compact);
  const contentWidth = 390 - styles.bar.paddingHorizontal * 2 - styles.bar.borderWidth * 2;
  const summaryMaxWidth = contentWidth - 64;
  return {
    badge: row.badge,
    summary: row.summary,
    compact,
    accessibilityLabel: `${row.badge}, ${row.summary}`,
    summaryLines: compact ? clampLines(estimatedLines(row.summary, styles.summary.fontSize, summaryMaxWidth)) : null,
  };
}

export function createWrapStyles(theme: WrapCardTheme, compact: boolean) {
  return StyleSheet.create({
    bar: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "flex-start",
      gap: compact ? 8 : 6,
      backgroundColor: theme.colors.surface1,
      borderColor: theme.colors.border,
      borderWidth: 1,
      borderRadius: 8,
      paddingHorizontal: compact ? 12 : 10,
      paddingVertical: compact ? 10 : 8,
    },
    badge: {
      color: theme.colors.foregroundMuted,
      backgroundColor: theme.colors.surface2,
      borderRadius: 6,
      paddingHorizontal: 6,
      paddingVertical: 2,
      fontSize: 11,
      fontWeight: "600",
    },
    summary: {
      flexGrow: 1,
      flexShrink: 1,
      flexBasis: compact ? "100%" : 200,
      color: theme.colors.foreground,
      fontSize: compact ? 13 : 12,
      lineHeight: compact ? 18 : 16,
    },
  });
}
