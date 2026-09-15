import type { PluginTheme } from "@getpaseo/plugin";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { getStatusColor, getStatusGlyph } from "./dag.js";
import { isExpanded, visibleFolders, type FolderNode, type FolderTree } from "./folders.js";

/**
 * Folder browser for OmO DAG runs and sub-agent sessions.
 *
 * A shell over the pure model in `folders.ts` (the same split as
 * `todo-visual.ts` + `todo-card.tsx`): every string, count and indent is
 * precomputed there, and this file maps the visible rows onto primitives.
 * It is deliberately hook-free so the whole tree materialises from one plain
 * function call — the same property `approval.tsx` has and its tests use.
 *
 * The browser is a controlled component — expand state lives with the caller
 * so a pill and a panel can share one tree:
 *
 *   const [expanded, setExpanded] = useState(() => defaultExpanded(tree));
 *   const toggle = (key: string) => setExpanded((prev) => toggleFolder(prev, key));
 *   <FolderBrowser tree={tree} expanded={expanded} theme={theme}
 *     layout={layout} onToggle={toggle} onOpenSession={openSession} />
 */

/** The part of the host layout the browser reacts to. */
export type FolderBrowserLayout = { readonly compact?: boolean | undefined; readonly platform?: string | undefined };

export interface FolderBrowserProps {
  tree: FolderTree;
  /** The expand/collapse set from `defaultExpanded` / `toggleFolder`. */
  expanded: ReadonlySet<string>;
  theme: PluginTheme;
  layout: FolderBrowserLayout;
  /** A folder row was pressed; the caller flips exactly this key. */
  onToggle(key: string): void;
  /** A task leaf was pressed; the payload is the owning session id. */
  onOpenSession(sessionId: string): void;
}

/** Rows plus the empty flag, derived once so the component stays a mapping. */
export interface FolderBrowserModel {
  rows: FolderNode[];
  empty: boolean;
}

/** Derives what the browser draws from the tree and the current expand set. */
export function folderBrowserModel(tree: FolderTree, expanded: ReadonlySet<string>): FolderBrowserModel {
  return { rows: visibleFolders(tree, expanded), empty: tree.empty };
}

const EMPTY_TITLE = "Empty folder";
const EMPTY_BODY = "No sessions, runs, or tasks recorded yet.";

/** Glyphs per row kind; task leaves use the shared status glyph instead. */
const KIND_GLYPH: Record<FolderNode["kind"], string> = {
  root: "⌂",
  session: "◎",
  run: "▦",
  task: "•",
};

/** Indentation per depth level; the compact budget is derived from it. */
const INDENT_STEP = 12;

/**
 * The stylesheet, owned here because the compact touch-target and indentation
 * budgets are derived from these exact values — the styles and the budgets
 * cannot drift apart the way two separately owned copies would.
 *
 * Compact is the phone form factor: 44px rows for thumb reach, one stepped-up
 * label size, and the card capped at the 390px content width so nothing can
 * push past the screen edge.
 */
export function createStyles(theme: PluginTheme, compact: boolean) {
  return StyleSheet.create({
    container: {
      width: "100%",
      ...(compact ? { maxWidth: 390 } : {}),
      gap: 2,
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      width: "100%",
      maxWidth: "100%",
      borderRadius: 8,
      // Vertical padding carries the 44px touch target on the phone.
      paddingVertical: compact ? 10 : 4,
      paddingRight: 8,
      minHeight: compact ? 44 : undefined,
    },
    caret: {
      color: theme.colors.foregroundMuted,
      fontSize: compact ? 14 : 12,
      lineHeight: 18,
      width: 12,
      textAlign: "center",
    },
    glyph: {
      fontSize: compact ? 13 : 11,
      lineHeight: 18,
      width: 14,
      textAlign: "center",
      fontVariant: ["tabular-nums"],
    },
    label: {
      flex: 1,
      flexShrink: 1,
      color: theme.colors.foreground,
      fontSize: compact ? 14 : 12.5,
      maxWidth: "100%",
    },
    count: {
      color: theme.colors.foregroundMuted,
      fontSize: 11,
      fontVariant: ["tabular-nums"],
    },
    empty: {
      width: "100%",
      maxWidth: 390,
      overflow: "hidden",
      borderWidth: 1,
      borderStyle: "dashed",
      borderColor: theme.colors.border,
      borderRadius: 12,
      backgroundColor: theme.colors.surface1,
      alignItems: "center",
      gap: 4,
      paddingVertical: compact ? 20 : 24,
      paddingHorizontal: 16,
    },
    emptyTitle: {
      color: theme.colors.foreground,
      fontWeight: "600",
      fontSize: compact ? 14 : 13,
    },
    emptyBody: {
      color: theme.colors.foregroundMuted,
      fontSize: compact ? 12.5 : 12,
      textAlign: "center",
    },
  });
}

export function FolderBrowser(props: FolderBrowserProps) {
  const { tree, expanded, theme, layout, onToggle, onOpenSession } = props;
  const compact = layout.compact === true;
  const styles = createStyles(theme, compact);
  const { rows, empty } = folderBrowserModel(tree, expanded);

  if (empty) {
    return (
      <View testID="folders-empty" style={styles.empty}>
        <Text style={styles.emptyTitle}>{EMPTY_TITLE}</Text>
        <Text style={styles.emptyBody}>{EMPTY_BODY}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {rows.map((node) => {
        const indent = { paddingLeft: node.depth * INDENT_STEP };
        const status = node.status;
        const glyphColor =
          status !== undefined
            ? getStatusColor(status, theme)
            : node.kind === "task"
              ? theme.colors.foregroundMuted
              : theme.colors.accent;

        if (node.kind === "task") {
          return (
            <Pressable
              key={node.key}
              accessibilityLabel={`Open ${node.label}`}
              accessibilityRole="button"
              onPress={() => onOpenSession(node.sessionId)}
              style={[styles.row, indent]}
            >
              <Text style={[styles.glyph, { color: glyphColor }]}>{getStatusGlyph(status)}</Text>
              <Text numberOfLines={1} ellipsizeMode="tail" style={styles.label}>
                {node.label}
              </Text>
              {node.count > 0 ? <Text style={styles.count}>{node.count}</Text> : null}
            </Pressable>
          );
        }

        return (
          <Pressable
            key={node.key}
            accessibilityLabel={`Toggle folder ${node.label}`}
            accessibilityRole="button"
            onPress={() => onToggle(node.key)}
            style={[styles.row, indent]}
          >
            <Text style={styles.caret}>{isExpanded(expanded, node.key) ? "▾" : "▸"}</Text>
            <Text style={[styles.glyph, { color: glyphColor }]}>{KIND_GLYPH[node.kind]}</Text>
            <Text numberOfLines={1} ellipsizeMode="tail" style={styles.label}>
              {node.label}
            </Text>
            <Text style={styles.count}>{node.count}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}
