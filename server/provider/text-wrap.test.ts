import { expect, it } from "vitest";

import { PLUGIN_ID } from "../../shared/ids.js";
import { WRAP_ROW_KIND } from "../../shared/wrap.js";
import { visibleTimelineItems } from "./text-wrap.js";

const TASK = `<omo-senpi-task>
Background task results are automatically delivered: an idle session is always woken, and a running turn receives them at its next tool boundary.
- /tasks shows this session's children
</omo-senpi-task>`;

it("publishes a pure harness prompt as a wrap, never a user_message", () => {
  const items = visibleTimelineItems("user", "user-1", TASK, { clientMessageId: "c1" });
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({
    type: "plugin",
    id: "user-1",
    pluginId: PLUGIN_ID,
    kind: WRAP_ROW_KIND,
  });
});

it("keeps leftover user prose as the native bubble after stripping wraps", () => {
  const items = visibleTimelineItems(
    "user",
    "user-2",
    `${TASK}\n\n이 블록을 wrapping 해줘`,
    { clientMessageId: "c2" },
  );
  expect(items.map((item) => item.type)).toEqual(["plugin", "user_message"]);
  expect(items[1]).toEqual({
    type: "user_message",
    id: "user-2",
    text: "이 블록을 wrapping 해줘",
    clientMessageId: "c2",
  });
});

it("leaves ordinary assistant text alone", () => {
  expect(visibleTimelineItems("assistant", "a-1", "hello")).toEqual([
    { type: "assistant_message", id: "a-1", text: "hello" },
  ]);
});

it("publishes a System Error compaction line as an Error wrap, never a bubble", () => {
  const text = "[System Error] Context remains above the compaction threshold because compaction did not complete";
  const items = visibleTimelineItems("assistant", "a-err", text);
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({
    type: "plugin",
    id: "a-err",
    pluginId: PLUGIN_ID,
    kind: WRAP_ROW_KIND,
    data: { badge: "오류", summary: "Context remains above the compaction threshold because compaction did not complete" },
  });
});

it("wraps timestamp and memory, unwraps user_query, and keeps leftover user prose", () => {
  const text = `[System Error] Context remains above the compaction threshold because compaction did not complete
<timestamp>Tuesday, Sep 15, 2026, 2:36 PM (UTC)</timestamp>
<user_query>
<memory_notice>
- 145 previous messages between you and the user are stored in recall memory
</memory_notice>
</user_query>`;
  const items = visibleTimelineItems("user", "user-4", text, { clientMessageId: "c4" });
  expect(items.map((item) => item.type)).toEqual(["plugin", "plugin", "plugin"]);
  expect(items.map((item) => (item as { data?: { badge?: string } }).data?.badge)).toEqual([
    "오류",
    "시각",
    "메모리",
  ]);
});

it("publishes timestamp and recalled-memory as wraps, never a user_message", () => {
  const text = `<timestamp>Tuesday, Sep 15, 2026, 2:41 PM (UTC)</timestamp>
<user_query>
<recalled-memory source="[[notes/pase-omo/wrap-blocks.md]]">
Kibitzer recalled a stored memory. It is a hint, not current state — verify before relying on it; read the source path for full context.
Wrap splitting is provider-side in server/provider/text-wrap.ts (visibleTimelineItems); the client wrapPluginItems converter only falls back for pure harness XML, since it replaces whole items.
</recalled-memory>
</user_query>`;
  const items = visibleTimelineItems("user", "user-5", text, { clientMessageId: "c5" });
  expect(items.map((item) => item.type)).toEqual(["plugin", "plugin"]);
  expect(items.map((item) => (item as { data?: { badge?: string } }).data?.badge)).toEqual(["시각", "메모리"]);
});

it("publishes each harness bar then the leftover user prose, matching the injected prompt", () => {
  const text = `${TASK}

<memory_notice>
- 5 previous messages between you and the user are stored in recall memory
</memory_notice>

이 블록이 paseo 의 omo 에이전트 사용중 그대로 표시되고있어`;
  const items = visibleTimelineItems("user", "user-3", text, { clientMessageId: "c3" });
  expect(items.map((item) => item.type)).toEqual(["plugin", "plugin", "user_message"]);
  expect(items[0]).toMatchObject({ kind: WRAP_ROW_KIND, data: { badge: "작업" } });
  expect(items[1]).toMatchObject({ kind: WRAP_ROW_KIND, data: { badge: "메모리" } });
  expect(items[2]).toEqual({
    type: "user_message",
    id: "user-3",
    text: "이 블록이 paseo 의 omo 에이전트 사용중 그대로 표시되고있어",
    clientMessageId: "c3",
  });
});
