import type { ProviderTimelineItem } from "@getpaseo/plugin/server/provider";

import { PLUGIN_ID } from "../../shared/ids.js";
import { WRAP_ROW_KIND, WRAP_ROW_VERSION, splitHarnessWraps, toWrapRow } from "../../shared/wrap.js";

type TextRole = "user" | "assistant";

/**
 * Turns one user/assistant string into the timeline items the chat should show.
 *
 * Harness XML becomes compact wrap rows; leftover prose keeps the native
 * bubble. A prompt that is only harness XML never becomes a user_message, so
 * Paseo cannot title the agent with `<omo-senpi-task>…`.
 */
export function visibleTimelineItems(
  role: TextRole,
  id: string,
  text: string,
  extra?: { clientMessageId: string },
): ProviderTimelineItem[] {
  const { wraps, remaining } = splitHarnessWraps(text);
  const items: ProviderTimelineItem[] = [];
  const pure = remaining.length === 0;

  for (const [index, wrap] of wraps.entries()) {
    const data = toWrapRow(wrap);
    if (data === null) continue;
    const wrapId = pure && wraps.length === 1 ? id : `${id}-wrap-${index}`;
    items.push({
      type: "plugin",
      id: wrapId,
      pluginId: PLUGIN_ID,
      kind: WRAP_ROW_KIND,
      version: WRAP_ROW_VERSION,
      data,
    });
  }

  if (remaining.length === 0) return items;
  if (role === "user") {
    items.push(
      extra === undefined
        ? { type: "user_message", id, text: remaining }
        : { type: "user_message", id, text: remaining, clientMessageId: extra.clientMessageId },
    );
    return items;
  }
  items.push({ type: "assistant_message", id, text: remaining });
  return items;
}
