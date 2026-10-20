import type { PluginTheme } from "@getpaseo/plugin";
import { Pressable, Text, View } from "react-native";
import type { DagRun, DagRunNode } from "../shared/dag.js";
import { statusLabel } from "./graph-visual.js";

export function dependencyExplanation(run: DagRun, node: DagRunNode): string | undefined {
  if (!["pending", "blocked", "scheduled"].includes(node.state)) return undefined;
  if (run.status === "paused") return "This run is paused.";
  const upstream = run.edges.filter(edge => edge.to === node.id).map(edge => run.nodes.find(n => n.id === edge.from));
  if (upstream.some(n => !n)) return "Dependency information is incomplete.";
  const waiting = upstream.filter((n): n is DagRunNode => !!n && n.state !== "completed");
  if (waiting.length) return `Waiting for: ${waiting.map(n => `${n.label} (${statusLabel(n.state)})`).join(", ")}.`;
  return node.state === "scheduled"
    ? "Scheduled to start; no more specific queue reason is recorded."
    : "Dependencies are satisfied; waiting for the scheduler.";
}

export function NodeDependencies({ run, node, theme, onSelectNode }: {
  run: DagRun; node: DagRunNode; theme: PluginTheme; onSelectNode: (id: string | null) => void;
}) {
  const dependencies = run.edges.filter(edge => edge.to === node.id).map(edge => run.nodes.find(n => n.id === edge.from)).filter((n): n is DagRunNode => !!n);
  const explanation = dependencyExplanation(run, node);
  return <View style={{ gap: 6 }}>
    {explanation ? <Text style={{ color: theme.colors.statusWarning }}>{explanation}</Text> : null}
    {dependencies.length ? <Text style={{ color: theme.colors.foregroundMuted }}>Depends on</Text> : null}
    {dependencies.map(dependency => <Pressable key={dependency.id} accessibilityRole="button"
      accessibilityLabel={`Inspect dependency ${dependency.label}`} onPress={() => onSelectNode(dependency.id)} style={{ minHeight: 32, justifyContent: "center" }}>
      <Text style={{ color: theme.colors.foreground }}>{dependency.label} · {statusLabel(dependency.state)}</Text>
    </Pressable>)}
  </View>;
}
