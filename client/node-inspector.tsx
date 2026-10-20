import type { PluginTheme } from "@getpaseo/plugin";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { DagRun, DagRunNode, DagTask, WorkerScope } from "../shared/dag.js";
import { NodeDependencies } from "./node-dependencies.js";
import { statusLabel } from "./graph-visual.js";
import { TaskDiagnostics } from "./task-diagnostics.js";
import { taskElapsed, shortDuration } from "./workflow-layout.js";
import { WorkerInspector } from "./worker-inspector.js";

/** Same recorded details in the board, cards and mobile chat inspector. */
export function NodeInspectorContent({ run, node, task, tasks, scope, theme, onSelectNode, now = Date.now() }: {
  run: DagRun; node: DagRunNode; task: DagTask | undefined; tasks: DagTask[];
  scope: WorkerScope | undefined; theme: PluginTheme; onSelectNode: (id: string | null) => void; now?: number;
}) {
  const heading = (label: string) => <Text style={{ color: theme.colors.foreground, fontWeight: "600", fontSize: 12 }}>{label}</Text>;
  const field = (label: string, value: string) => <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{`${label}: ${value}`}</Text>;
  const startedAt = node.startedAt ?? task?.startedAt;
  const endedAt = node.completedAt ?? task?.completedAt;
  // A terminal task with no finish clock must not appear to keep accumulating time.
  const terminal = ["completed", "failed", "cancelled", "skipped"].includes(node.state);
  const elapsed = terminal && !endedAt ? undefined : taskElapsed({ id: task?.id ?? "st_unknown", ...(startedAt ? { startedAt } : {}), ...(endedAt ? { completedAt: endedAt } : {}) }, now);
  const effective = task?.modelRef ?? task?.model;
  const requested = task?.requestedModel ?? node.requestedModel;
  const downstream = run.edges.filter(edge => edge.from === node.id).map(edge => run.nodes.find(n => n.id === edge.to)).filter(n => !!n);
  const attempts = task?.modelAttempts ?? [];
  return <View style={{ gap: 12 }}>
    <View style={{ gap: 4 }}>
      {heading("Execution")}
      {field("Node", node.label)}
      {field("Status", `${statusLabel(node.state)} · ${node.attempt > 0 ? `attempt ${node.attempt}` : "not dispatched"}`)}
      {task?.status && task.status !== node.state ? field("Worker status", `${task.status} (separate from workflow node)`) : null}
      {field("Elapsed", elapsed === undefined ? "Not recorded" : shortDuration(elapsed))}
      {startedAt ? field("Started", startedAt) : null}{endedAt ? field("Finished", endedAt) : null}
      {task?.turns !== undefined ? field("Turns", String(task.turns)) : null}
      {task?.toolCalls !== undefined ? field("Tool calls", String(task.toolCalls)) : null}
      {task?.description ? <Text selectable style={{ color: theme.colors.foreground, fontSize: 12 }}>{task.description}</Text> : null}
    </View>
    <View style={{ gap: 4 }}>
      {heading("Routing")}
      {field(node.routeKind === "agent" ? "Agent" : node.routeKind === "category" ? "Category" : "Agent / category", node.route ?? task?.agent ?? "Not recorded")}
      {field(task?.modelStage === "effective" ? "Effective model" : task?.modelStage === "resolved" ? "Resolved at spawn" : task?.modelStage === "planned" ? "Planned model" : "Model (recorded)", effective ?? "Not recorded")}
      {requested && requested !== effective ? field("Requested model", requested) : null}
      {task?.resolvedModel && task.resolvedModel !== effective ? field("Resolved at spawn", task.resolvedModel) : null}
      {field("Reasoning (recorded)", task?.reasoning ?? "Not recorded")}
      {task?.variant ? field("Variant (recorded)", task.variant) : null}
    </View>
    <View style={{ gap: 4 }}>
      {heading("Activity")}
      {task?.progress ? <Text selectable style={{ color: theme.colors.foreground, fontSize: 12 }}>{task.progress}</Text> : null}
      <TaskDiagnostics task={task} theme={theme} hideTerminalReason />
      {!task?.progress && !task?.lastActivityAt ? field("Activity", "No recorded activity") : null}
    </View>
    <View style={{ gap: 4 }}>
      {heading("Dependencies")}
      <NodeDependencies run={run} node={node} theme={theme} onSelectNode={onSelectNode} />
      {!run.edges.some(edge => edge.to === node.id) ? field("Depends on", "No dependencies") : null}
      {downstream.length ? field("Followed by", "These nodes also wait for their other dependencies") : null}
      {downstream.map(next => <Pressable key={next!.id} accessibilityRole="button" accessibilityLabel={`Inspect successor ${next!.label}`}
        onPress={() => onSelectNode(next!.id)} style={{ minHeight: 32, justifyContent: "center" }}>
        <Text style={{ color: theme.colors.accent, fontSize: 12 }}>{next!.label} · {statusLabel(next!.state)}</Text>
      </Pressable>)}
    </View>
    <View style={{ gap: 4 }}>
      {heading("Result")}
      {task?.terminalReason ? field("Terminal reason", task.terminalReason) : null}
      {node.error ? <Text selectable style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{node.error}</Text> : null}
      {node.outputPreview ? <ScrollView style={{ maxHeight: 180 }}><Text selectable style={{ color: theme.colors.foreground, fontSize: 12 }}>{node.outputPreview}</Text></ScrollView>
        : field("Output", node.outputBytes === 0 ? "Native record contains no output" : "No result preview recorded")}
      {node.outputTruncated ? field("Preview", `Bounded excerpt${node.outputBytes === undefined ? "" : ` · ${node.outputBytes} bytes recorded`}. Use worker output for more.`) : null}
    </View>
    <View style={{ gap: 4 }}>
      {heading("Recorded history")}
      {field("Dispatch / attachment attempts", `${node.attempt} recorded; these can include reattachments, not just retries`)}
      {field("Execution attempt", node.execAttempt === undefined ? "Not recorded; retry count cannot be inferred" : String(node.execAttempt))}
      {field("Attempt timeline", "Detailed per-attempt history is not recorded in this snapshot")}
      {attempts.length ? field("Model attempts", `Showing ${attempts.length} of ${task?.modelAttemptCount ?? attempts.length} recorded entries; timestamps and reasons are not inferred`) : null}
      {attempts.map((attempt, i) => <Text key={i} style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{[attempt.model, attempt.reasoning ? `reasoning ${attempt.reasoning}` : undefined, attempt.variant ? `variant ${attempt.variant}` : undefined].filter(Boolean).join(" · ")}</Text>)}
      {node.diagnosticCount ? field("Diagnostics", `Showing ${node.diagnostics?.length ?? 0} of ${node.diagnosticCount} recorded entries`) : null}
      {node.diagnostics?.map((entry, i) => <Text key={i} selectable style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{entry.at ?? "Time not recorded"} · {entry.kind}: {entry.message}</Text>)}
    </View>
    {heading("Workers")}
    {task ? <WorkerInspector key={task.id} task={task} tasks={tasks} scope={scope} theme={theme} /> : field("Worker", node.taskId ? `${node.taskId} · record unavailable` : "No worker assigned")}
  </View>;
}
