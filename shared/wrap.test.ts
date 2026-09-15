import { expect, it } from "vitest";

import {
  WRAP_ROW_KIND,
  WRAP_ROW_VERSION,
  WrapRowSchema,
  badgeFor,
  isHarnessTag,
  splitHarnessWraps,
  summarizeHarness,
  toWrapRow,
  wrapPluginItems,
} from "./wrap";

const COMPACTION = "Context remains above the compaction threshold because compaction did not complete";

const TASK = `<omo-senpi-task>
Background task results are automatically delivered: an idle session is always woken, and a running turn receives them at its next tool boundary.
- /tasks shows this session's children; task_output is for one midpoint status or transcript peek (mode:"tail" for recent output).
- task_send always steers a message into the addressed child, while task_cancel ends it.
If no independent work remains, end your turn.
</omo-senpi-task>`;

it("wraps the omo-senpi-task injection as a Task bar, not raw XML", () => {
  const split = splitHarnessWraps(TASK);
  expect(split.remaining).toBe("");
  expect(split.wraps).toEqual([
    {
      tag: "omo-senpi-task",
      body: TASK.replace(/^<omo-senpi-task>\n/, "").replace(/\n<\/omo-senpi-task>$/, "").trim(),
    },
  ]);
  expect(summarizeHarness(split.wraps[0]!.body)).toBe(
    "Background task results are automatically delivered: an idle session is always woken, and a running turn receives them at its next tool boundary.",
  );
});

it("strips memory notices and leaves the real user text", () => {
  const split = splitHarnessWraps(`${TASK}

<memory_notice>
- 13 user turns since your last memory save.
</memory_notice>

이 블록이 paseo 의 omo 에이전트 사용중 그대로 표시되고있어`);
  expect(split.remaining).toBe("이 블록이 paseo 의 omo 에이전트 사용중 그대로 표시되고있어");
  expect(split.wraps.map((wrap) => wrap.tag)).toEqual(["omo-senpi-task", "memory_notice"]);
});

it("does not treat ordinary HTML as a harness wrap", () => {
  const html = "<div>keep me</div>";
  expect(isHarnessTag("div")).toBe(false);
  expect(splitHarnessWraps(html)).toEqual({ remaining: html, wraps: [] });
});

it("does not wrap mixed messages on the client transformer, so the bubble stays native", () => {
  expect(
    wrapPluginItems({
      id: "user-1",
      text: `${TASK}\n\nplease wrap this`,
    }),
  ).toBeUndefined();
});

it("replaces a prompt that is only harness XML with wrap rows", () => {
  const result = wrapPluginItems({ id: "user-1", text: TASK });
  expect(result?.items).toHaveLength(1);
  expect(result?.items[0]).toEqual({
    type: "plugin",
    id: "user-1",
    kind: WRAP_ROW_KIND,
    version: WRAP_ROW_VERSION,
    data: {
      tag: "omo-senpi-task",
      badge: "Task",
      summary:
        "Background task results are automatically delivered: an idle session is always woken, and a running turn receives them at its next tool boundary.",
    },
  });
  expect(WrapRowSchema.parse(result?.items[0]?.data).badge).toBe("Task");
});

it("gives each of several pure wraps its own id off the source", () => {
  const result = wrapPluginItems({
    id: "user-1",
    text: `${TASK}\n<memory_notice>\n- 5 previous messages\n</memory_notice>`,
  });
  expect(result?.items.map((item) => item.id)).toEqual(["user-1-wrap-0", "user-1-wrap-1"]);
  expect(result?.items[1]?.data.badge).toBe("Memory");
});

it("titles unknown omo- tags from the last path segment", () => {
  expect(badgeFor("omo-fallback-architect:notice")).toBe("Notice");
});

it("strips empty harness tags without drawing a bar", () => {
  expect(splitHarnessWraps("<omo-senpi-task></omo-senpi-task>\nhello")).toEqual({
    remaining: "hello",
    wraps: [],
  });
});

it("wraps a timestamp as a Time bar and unwraps user_query so the real prompt remains", () => {
  const split = splitHarnessWraps(`<timestamp>Tuesday, Sep 15, 2026, 8:01 AM (UTC)</timestamp>
<user_query>continue</user_query>`);
  expect(split.wraps).toEqual([{ tag: "timestamp", body: "Tuesday, Sep 15, 2026, 8:01 AM (UTC)" }]);
  expect(split.remaining).toBe("continue");
  expect(badgeFor("timestamp")).toBe("Time");
});

it("unwraps user_query so a nested memory notice still becomes a Memory bar", () => {
  const split = splitHarnessWraps(`<user_query>
<memory_notice>
- 145 previous messages between you and the user are stored in recall memory
</memory_notice>
</user_query>`);
  expect(split.remaining).toBe("");
  expect(split.wraps.map((wrap) => wrap.tag)).toEqual(["memory_notice"]);
});

it("wraps a System Error compaction line as an Error bar", () => {
  const text = "[System Error] Context remains above the compaction threshold because compaction did not complete";
  const split = splitHarnessWraps(text);
  expect(split.remaining).toBe("");
  expect(split.wraps).toEqual([
    {
      tag: "system-error",
      body: "Context remains above the compaction threshold because compaction did not complete",
    },
  ]);
  expect(toWrapRow(split.wraps[0]!)).toEqual({
    tag: "system-error",
    badge: "Error",
    summary: "Context remains above the compaction threshold because compaction did not complete",
  });
});

it("wraps a bare compaction-threshold sentence the same way", () => {
  const split = splitHarnessWraps(COMPACTION);
  expect(split.remaining).toBe("");
  expect(split.wraps).toEqual([{ tag: "system-error", body: COMPACTION }]);
});

it("replaces a System Error timeline item with an Error wrap", () => {
  const result = wrapPluginItems({
    id: "err-1",
    type: "error",
    message: `[System Error] ${COMPACTION}`,
  });
  expect(result?.items).toEqual([
    {
      type: "plugin",
      id: "err-1",
      kind: WRAP_ROW_KIND,
      version: WRAP_ROW_VERSION,
      data: { tag: "system-error", badge: "Error", summary: COMPACTION },
    },
  ]);
});

it("wraps a kibitzer recalled-memory block as a Memory bar, skipping the preamble", () => {
  const text = `<timestamp>Tuesday, Sep 15, 2026, 2:41 PM (UTC)</timestamp>
<user_query>
<recalled-memory source="[[notes/pase-omo/wrap-blocks.md]]">
Kibitzer recalled a stored memory. It is a hint, not current state — verify before relying on it; read the source path for full context.
Wrap splitting is provider-side in server/provider/text-wrap.ts (visibleTimelineItems); the client wrapPluginItems converter only falls back for pure harness XML, since it replaces whole items.
</recalled-memory>
</user_query>`;
  const split = splitHarnessWraps(text);
  expect(split.remaining).toBe("");
  expect(split.wraps.map((wrap) => wrap.tag)).toEqual(["timestamp", "recalled-memory"]);
  expect(toWrapRow(split.wraps[1]!)).toEqual({
    tag: "recalled-memory",
    badge: "Memory",
    summary:
      "Wrap splitting is provider-side in server/provider/text-wrap.ts (visibleTimelineItems); the client wrapPluginItems converter only falls back for pure harness XML, since it replaces whole items.",
  });
  expect(isHarnessTag("recalled-memory")).toBe(true);
});
