import type { PluginCleanup } from "@getpaseo/plugin";
import type { PluginClientContext, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { Text, View } from "react-native";

import { WRAP_ROW_KIND, WRAP_ROW_VERSION, WrapRowSchema, wrapPluginItems, type WrapRow } from "../shared/wrap";
import { createWrapStyles, wrapCardModel } from "./wrap-visual";

/**
 * A one-strip wrap for OmO harness XML, matching the TUI usage bar: badge plus
 * wrapping summary, no raw tags.
 */
export function WrapCard({ item, theme, layout }: PluginTimelineItemProps<WrapRow>) {
  const compact = layout.compact;
  const styles = useMemo(() => createWrapStyles(theme, compact), [theme, compact]);
  const model = wrapCardModel(item.data, theme, { compact });

  return (
    <View style={styles.bar} accessibilityLabel={model.accessibilityLabel}>
      <Text style={styles.badge}>{model.badge}</Text>
      <Text style={styles.summary} numberOfLines={model.summaryLines ?? undefined}>
        {model.summary}
      </Text>
    </View>
  );
}

export function contributeWrapClient(client: PluginClientContext): PluginCleanup {
  const registrations: PluginCleanup[] = [
    client.addTimelineRenderer({
      kind: WRAP_ROW_KIND,
      version: WRAP_ROW_VERSION,
      schema: WrapRowSchema,
      Component: WrapCard,
    }),
    client.addTimelineTransformer({
      id: "omo-wrap-user",
      query: { itemType: "user_message" },
      transform: ({ item }) => wrapPluginItems(item),
    }),
    client.addTimelineTransformer({
      id: "omo-wrap-assistant",
      query: { itemType: "assistant_message" },
      transform: ({ item }) => wrapPluginItems(item),
    }),
  ];

  return () => {
    for (const release of registrations.reverse()) release();
    registrations.length = 0;
  };
}
