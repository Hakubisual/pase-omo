import type { PluginTheme } from "@getpaseo/plugin";
import { Pressable, Text, View } from "react-native";
import type { DagRun } from "../shared/dag.js";

export type FocusMode = "all" | "running" | "dependencies";

/** Every state has its own outcome; settled is never presented as success. */
export function outcomeSummary(run: DagRun): string {
  const groups: Array<[string, string[]]> = [
    ["done", ["completed"]], ["running", ["running"]],
    ["waiting", ["pending", "blocked", "scheduled"]], ["paused", ["paused"]],
    ["failed", ["failed"]], ["cancelled", ["cancelled"]], ["skipped", ["skipped"]],
  ];
  return groups.map(([label, states]) => [label, run.nodes.filter(node => states.includes(node.state)).length] as const)
    .filter(([, count]) => count > 0).map(([label, count]) => `${count} ${label}`).join(" · ") || "No nodes";
}

/** Keep positions and hit targets intact. Follow recorded dependencies transitively. */
export function focusedNodes(run: DagRun, mode: FocusMode, selected: string | null): Set<string> {
  const ids = new Set(run.nodes.map(node => node.id));
  if (mode === "all" || (mode === "dependencies" && (!selected || !ids.has(selected)))) return ids;
  const result = new Set(mode === "running" ? run.nodes.filter(node => node.state === "running").map(node => node.id) : [selected!]);
  if (mode === "dependencies") {
    const queue = [...result];
    while (queue.length) {
      const id = queue.pop()!;
      for (const edge of run.edges) if (edge.to === id && ids.has(edge.from) && !result.has(edge.from)) {
        result.add(edge.from); queue.push(edge.from);
      }
    }
  }
  return result;
}

export function WorkflowMonitor({ run, selected, mode, onChange, theme }: {
  run: DagRun; selected: string | null; mode: FocusMode; onChange: (mode: FocusMode) => void; theme: PluginTheme;
}) {
  const effective = mode === "dependencies" && !run.nodes.some(n => n.id === selected) ? "all" : mode;
  return <View style={{ paddingHorizontal: 14, paddingVertical: 8, gap: 8 }}>
    <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>{outcomeSummary(run)}</Text>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
      {([["all", "Show all"], ["running", "Focus running"], ["dependencies", "Selected + dependencies"]] as const).map(([value, label]) => {
        const disabled = value === "dependencies" && !run.nodes.some(n => n.id === selected);
        return <Pressable key={value} accessibilityRole="button" accessibilityLabel={label}
          accessibilityState={{ selected: effective === value, disabled }} disabled={disabled}
          onPress={() => onChange(value)} style={{ minHeight: 36, justifyContent: "center", paddingHorizontal: 10, borderWidth: 1,
            borderRadius: 6, borderColor: effective === value ? theme.colors.accent : theme.colors.border,
            backgroundColor: effective === value ? theme.colors.surface2 : "transparent", opacity: disabled ? 0.5 : 1 }}>
          <Text style={{ fontSize: 12, color: theme.colors.foreground }}>{label}</Text>
        </Pressable>;
      })}
    </View>
    {effective === "running" && !run.nodes.some(n => n.state === "running") ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>No nodes are currently running. Show all to restore emphasis.</Text> : null}
    <Text style={{ minHeight: 28, color: theme.colors.foregroundMuted, fontSize: 11 }}>{effective === "all" ? "Focus changes emphasis only. All nodes remain selectable." : "Other nodes are dimmed and remain selectable."}</Text>
  </View>;
}
