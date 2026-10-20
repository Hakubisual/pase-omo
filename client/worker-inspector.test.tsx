import type { PluginTheme } from "@getpaseo/plugin";
import { expect, test, vi } from "vitest";
const harness = vi.hoisted(() => ({ selected: null as string | null, options: undefined as unknown, read: vi.fn() }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useState: () => [harness.selected, (id: string | null) => { harness.selected = id; }] }));
vi.mock("@tanstack/react-query", () => ({ useQuery: (options: unknown) => { harness.options = options; return {}; } }));
vi.mock("@getpaseo/plugin/client", () => ({ useRpc: () => harness.read }));
import { WorkerInspector, workerGroup } from "./worker-inspector.js";
import type { DagTask } from "../shared/dag.js";
const root: DagTask = { id: "st_root", description: "Implement", status: "running" };
const child: DagTask = { id: "st_child", parentTaskId: root.id, description: "Review", status: "running" };
const other: DagTask = { id: "st_other", description: "Unrelated" };
function elements(node: unknown): Array<{ props: Record<string, any> }> {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object") return [];
  const e = node as { props: Record<string, any> }; return [e, ...elements(e.props?.children)];
}
test("worker ownership follows parents at any depth, keeping independent work separate", () => {
  const grand: DagTask = { id: "st_grand", parentTaskId: child.id };
  const tasks = new Map([root, child, grand, other].map(t => [t.id, t]));
  expect(workerGroup(grand, tasks, new Map([[root.id, "Build"]]))).toBe("For: Build");
  expect(workerGroup(other, tasks, new Map([[root.id, "Build"]]))).toBe("Other session work");
  tasks.set(root.id, { ...root, parentTaskId: grand.id });
  expect(workerGroup(grand, tasks, new Map())).toBe("Other session work");
});
test("only explicit descendants get links and clicking a link reads the same worker without prompting", () => {
  harness.selected = null;
  const props = { task: root, tasks: [child, other], scope: { agentId: "parent-agent" }, theme: { colors: {} } as PluginTheme };
  const tree = WorkerInspector(props);
  const actions = elements(tree).filter(e => String(e.props.accessibilityLabel).startsWith("Open output for"));
  expect(actions.map(e => e.props.accessibilityLabel)).toEqual(["Open output for Implement", "Open output for Review"]);
  expect((harness.options as { enabled: boolean }).enabled).toBe(false);
  actions[1]!.props.onPress(); WorkerInspector(props);
  expect(harness.options).toMatchObject({ enabled: true, queryKey: ["dag-worker-output", { agentId: "parent-agent" }, child.id, "running"], refetchInterval: 2000 });
});
test("closed workers stop polling and the action is absent without a verified session scope", () => {
  harness.selected = root.id;
  WorkerInspector({ task: { ...root, status: "completed" }, scope: { cwd: "/fixture", sessionId: "parent" }, theme: { colors: {} } as PluginTheme });
  expect(harness.options).toMatchObject({ enabled: true, refetchInterval: false, queryKey: ["dag-worker-output", { cwd: "/fixture", sessionId: "parent" }, root.id, "completed"] });
  const tree = WorkerInspector({ task: root, scope: undefined, theme: { colors: {} } as PluginTheme });
  expect(elements(tree).some(e => String(e.props.accessibilityLabel).startsWith("Open output for"))).toBe(false);
  expect(harness.options).toMatchObject({ enabled: false });
});

test("completion between polls changes query identity and reads the final excerpt once", async () => {
  harness.selected = root.id;
  const props = { task: root, scope: { agentId: "parent-agent" }, theme: { colors: {} } as PluginTheme };
  harness.read.mockResolvedValueOnce({ text: "Before final" }).mockResolvedValueOnce({ text: "Final result" });
  WorkerInspector(props);
  const live = harness.options as { queryKey: unknown[]; queryFn: () => Promise<{ text: string }> };
  expect((await live.queryFn()).text).toBe("Before final");
  WorkerInspector({ ...props, task: { ...root, status: "completed" } });
  const done = harness.options as { queryKey: unknown[]; queryFn: () => Promise<{ text: string }>; refetchInterval: boolean };
  expect(done.queryKey).not.toEqual(live.queryKey);
  expect(done.refetchInterval).toBe(false);
  expect((await done.queryFn()).text).toBe("Final result");
});
