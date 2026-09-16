import { expect, it } from "vitest";

import { wrapCardModel } from "./wrap-visual";

const theme = {
  colors: {
    surface1: "#111",
    surface2: "#222",
    border: "#333",
    foreground: "#fff",
    foregroundMuted: "#aaa",
  },
} as const;

const row = {
  tag: "omo-senpi-task",
  badge: "Task",
  summary: "Background task results are automatically delivered: an idle session is always woken.",
};

it("keeps the usage-bar copy and lets desktop text wrap without a line bound", () => {
  const model = wrapCardModel(row, theme);
  expect(model.badge).toBe("Task");
  expect(model.summary).toBe(row.summary);
  expect(model.summaryLines).toBeNull();
  expect(model.accessibilityLabel).toBe(`Task, ${row.summary}`);
});

it("line-bounds the summary on the phone so a long wrap cannot overflow", () => {
  const model = wrapCardModel(row, theme, { compact: true });
  expect(model.compact).toBe(true);
  expect(model.summaryLines).toBeGreaterThanOrEqual(1);
  expect(model.summaryLines).toBeLessThanOrEqual(3);
});
