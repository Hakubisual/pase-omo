import type { PluginTheme } from "@getpaseo/plugin";
import { expect, test, vi } from "vitest";
import type { WorkerOutputEntry } from "../shared/dag.js";
const state = vi.hoisted(() => ({ expanded: false }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useState: () => [state.expanded, (value: boolean | ((old: boolean) => boolean)) => { state.expanded = typeof value === "function" ? value(state.expanded) : value; }] }));
import { AssistantOutput, outputRows, ToolOutput, WorkerOutputView } from "./worker-output-view.js";
const theme = { colors: {} } as PluginTheme;
function elements(value: any): any[] { return Array.isArray(value) ? value.flatMap(elements) : value?.props ? [value, ...elements(value.props.children)] : []; }
function text(value: any): string { return Array.isArray(value) ? value.map(text).join("") : value?.props ? text(value.props.children) : typeof value === "string" ? value : ""; }
const call: WorkerOutputEntry = { id: "call", type: "tool_call", toolName: "grep", toolCallId: "call-1", text: "" };
const result: WorkerOutputEntry = { id: "result", type: "tool_result", toolName: "grep", toolCallId: "call-1", text: "42- def handler():\n43-     return True", isError: false };

test("explicit call IDs correlate results without swallowing assistant messages", () => {
  const rows = outputRows([{ id: "a", type: "assistant", text: "Before" }, call, { id: "b", type: "assistant", text: "While the tool runs" }, result]);
  expect(rows.map(row => row.type)).toEqual(["assistant", "tool", "assistant"]);
  expect(rows[1]).toMatchObject({ id: call.id, name: "grep", results: [result], callRecorded: true });
  expect(outputRows([call, { ...result, toolCallId: "foreign" }])).toHaveLength(2);
});
test("unpaired results stay separate and repeated same-name calls are never guessed", () => {
  const rows = outputRows([call, { ...call, id: "call2", toolCallId: "call-2" }, { ...result, toolCallId: undefined } as unknown as WorkerOutputEntry]);
  expect(rows).toHaveLength(3); expect(rows[2]).toMatchObject({ callRecorded: false, results: [expect.objectContaining({ id: "result" })] });
});
test("tool output is collapsed by default and explicit expansion shows literal monospace text", () => {
  state.expanded = false; const row = outputRows([call, result])[0]!;
  if (row.type !== "tool") throw new Error("Missing tool row");
  let tree = ToolOutput({ row, theme });
  expect(text(tree)).not.toContain("def handler");
  const button = elements(tree).find(e => e.props.accessibilityRole === "button")!;
  expect(button.props.accessibilityState.expanded).toBe(false);button.props.onPress();
  tree = ToolOutput({ row, theme }); expect(text(tree)).toContain(result.text);
  const code = elements(tree).find(e => e.props.children === result.text)!;
  expect(code.props.style.fontFamily).toBe("monospace");
  expect(elements(tree).find(e => e.props.accessibilityRole === "button")!.props.accessibilityState.expanded).toBe(true);
});
test("errors, clipped results and unavailable calls are explicit without claiming a tool is running", () => {
  state.expanded = true;const row = outputRows([{ ...result, isError: true, truncated: true }])[0]!;
  if (row.type !== "tool") throw new Error("Missing result row");
  const content = text(ToolOutput({ row, theme }));
  expect(content).toContain("Error");expect(content).toContain("Partial tool result");expect(content).toContain("tool call is not included");
  const pending = outputRows([call])[0]!;
  if (pending.type !== "tool") throw new Error("Missing tool row");
  expect(text(ToolOutput({ row: pending, theme }))).toContain("No result");
  expect(text(ToolOutput({ row: pending, theme }))).not.toContain("Running");
});
test("assistant formatting keeps code blocks distinct and never renders HTML or image resources", () => {
  const tree = AssistantOutput({ text: "## Findings\n- **Passed** `check`\n```python\ndef handler():\n    return True\n```\n<img src='https://invalid.example/tracker'>", theme });
  const all = elements(tree);
  expect(text(tree)).toContain("Findings");
  expect(all.some(e => e.props.style?.fontFamily === "monospace" && e.props.children.includes("def handler"))).toBe(true);
  expect(all.some(e => e.props.source || e.props.href || e.props.dangerouslySetInnerHTML)).toBe(false);
  expect(all.filter(e => typeof e.type === "function").every(e => !e.props.text?.includes("PRIVATE"))).toBe(true);
});
test("old hosts remain readable with an explicitly labelled plain-text fallback", () => {
  const tree = WorkerOutputView({ output: { taskId: "st_x", text: "Legacy output", truncated: false }, theme });
  expect(text(tree)).toContain("Legacy plain-text excerpt");expect(text(tree)).toContain("Legacy output");
});

test("long assistant code has a vertical scroller around its horizontal code scroller", () => {
  const tree = AssistantOutput({ text: "```python\n" + Array.from({ length: 40 }, (_, i) => `print(${i})`).join("\n") + "\n```", theme });
  const outer = elements(tree).find(e => e.props.style?.maxHeight === 220)!;
  expect(outer.props.horizontal).not.toBe(true);
  expect(elements(outer).some(e => e.props.horizontal === true)).toBe(true);
  expect(text(tree)).toContain("print(39)");
});
