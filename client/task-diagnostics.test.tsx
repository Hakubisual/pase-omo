import type { PluginTheme } from "@getpaseo/plugin";
import { expect, test, vi } from "vitest";
vi.mock("react-native", () => ({ Text: "Text", View: "View" }));
import { TaskDiagnostics } from "./task-diagnostics.js";
const theme = { colors: { foreground: "black", foregroundMuted: "gray", statusWarning: "orange" } } as PluginTheme;
function text(node: unknown): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join(" ");
  return text((node as { props?: { children?: unknown } }).props?.children);
}
test("shared diagnostics show the reason, observed count and recorded activity", () => {
  const result = text(TaskDiagnostics({ theme, task: { id: "st_x", terminalReason: "Superseded by a new run", observedToolCalls: 72, lastActivityAt: "2026-10-19T08:43:00Z" } }));
  expect(result).toContain("Reason: Superseded by a new run");
  expect(result).toContain("Observed tool calls: 72");
  expect(result).toContain("Last recorded activity:");
});
test("native totals suppress the fallback count and unknown timestamps stay unknown", () => {
  const result = text(TaskDiagnostics({ theme, task: { id: "st_x", toolCalls: 99, observedToolCalls: 72, lastActivityAt: "invalid", activityError: "Activity is partial" } }));
  expect(result).not.toContain("Observed tool calls:");
  expect(result).not.toContain("Last recorded activity:");
  expect(result).toContain("Activity is partial");
});
