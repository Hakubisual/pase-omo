import type { PluginCleanup } from "@getpaseo/plugin";
import type { PluginClientContext, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";

import { TODO_ROW_KIND, TODO_ROW_VERSION, TodoRowSchema, todoPluginItems, type TodoRow } from "../shared/todo";
import { createStyles, todoCardModel } from "./todo-visual";

/**
 * An agent's todo list, drawn so progress is visible without reading: finished
 * work is checked off and struck through, and the single task in flight is lit.
 *
 * Every string, count and line bound is precomputed by `todoCardModel`; this
 * component is a shell that maps it onto primitives. The model derives from
 * `item.data` on every render, so a mid-stream status flip flows straight
 * through, and `layout.compact` (the host's phone form factor) selects the
 * mobile-first treatment: stacked header, 44px rows, line-bounded labels.
 */
export function TodoCard({ item, theme, layout }: PluginTimelineItemProps<TodoRow>) {
  const compact = layout.compact;
  const styles = useMemo(() => createStyles(theme, compact), [theme, compact]);
  const model = todoCardModel(item.data, theme, { compact });

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text style={styles.badge}>{model.badge}</Text>
        <Text style={styles.title} numberOfLines={model.titleLines ?? undefined}>
          {model.title}
        </Text>
        <Text style={styles.counter}>{model.counter}</Text>
      </View>

      <View style={styles.track}>
        <View style={[styles.fill, { width: `${model.percent}%` }]} />
      </View>

      <View style={styles.list}>
        {model.rows.map((row) => (
          <View
            key={row.key}
            accessibilityLabel={row.accessibilityLabel}
            style={[styles.row, { backgroundColor: row.visual.backgroundColor }]}
          >
            <Text style={[styles.marker, { color: row.visual.markerColor }]}>{row.visual.marker}</Text>
            <View style={styles.body}>
              <Text
                style={[
                  styles.text,
                  {
                    color: row.visual.textColor,
                    fontWeight: row.visual.lit ? "600" : "400",
                    textDecorationLine: row.visual.struck ? "line-through" : "none",
                  },
                ]}
                numberOfLines={row.textLines ?? undefined}
              >
                {row.text}
              </Text>
              {row.showActiveForm && row.activeForm !== null ? (
                <Text style={styles.activeForm} numberOfLines={row.activeFormLines ?? undefined}>
                  {row.activeForm}
                </Text>
              ) : null}
            </View>
          </View>
        ))}
      </View>

      {model.streaming ? <Text style={styles.footer}>{model.footer}</Text> : null}
    </View>
  );
}

/**
 * Replaces the built-in todo row with the live card.
 *
 * The transform emits one item and no id, so Paseo keeps identity from the
 * source item and the card updates in place while the turn streams.
 */
export function contributeTodoClient(client: PluginClientContext): PluginCleanup {
  const registrations: PluginCleanup[] = [
    client.addTimelineRenderer({
      kind: TODO_ROW_KIND,
      version: TODO_ROW_VERSION,
      schema: TodoRowSchema,
      Component: TodoCard,
    }),
    client.addTimelineTransformer({
      id: "omo-todo",
      query: { itemType: "todo" },
      transform: ({ item, phase }) => todoPluginItems(item, phase),
    }),
  ];

  return () => {
    for (const release of registrations.reverse()) release();
    registrations.length = 0;
  };
}
