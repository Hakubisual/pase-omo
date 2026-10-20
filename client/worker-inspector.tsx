import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { WorkerOutputView } from "./worker-output-view.js";
import { workerOutputRpc, type DagTask, type WorkerScope } from "../shared/dag.js";

export function workerGroup(task: DagTask, tasks: Map<string, DagTask>, nodeTasks: Map<string, string>): string {
  let current: DagTask | undefined = task;
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    const label = nodeTasks.get(current.id);
    if (label) return `For: ${label}`;
    current = current.parentTaskId ? tasks.get(current.parentTaskId) : undefined;
  }
  return "Other session work";
}

export function WorkerInspector({ task, tasks = [], scope, theme, compact = false }: {
  task: DagTask; tasks?: DagTask[]; scope: WorkerScope | undefined; theme: PluginTheme; compact?: boolean;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const fetchOutput = useRpc(workerOutputRpc);
  const selectedTask = [task, ...tasks].find(t => t.id === selected);
  const query = useQuery({
    // Completion must force one final read even when its snapshot arrives between polls.
    queryKey: ["dag-worker-output", scope, selected, selectedTask?.status],
    enabled: Boolean(scope && selectedTask),
    refetchInterval: selectedTask?.status === "running" ? 2000 : false,
    queryFn: () => fetchOutput({ ...scope!, taskId: selectedTask!.id }),
  });
  // Traverse explicit parent links only: never infer ownership from timestamps or list order.
  const visited = new Set<string>([task.id]);
  const rows: Array<{ task: DagTask; depth: number }> = [{ task, depth: 0 }];
  const add = (id: string, depth: number) => {
    for (const child of tasks.filter(t => t.parentTaskId === id)) {
      if (visited.has(child.id)) continue;
      visited.add(child.id); rows.push({ task: child, depth }); add(child.id, Math.min(depth + 1, 6));
    }
  };
  add(task.id, 1);
  return <View style={{ gap: 6 }}>
    {!compact ? <Text style={{ color: theme.colors.foregroundMuted }}>Worker{rows.length > 1 ? `s (${rows.length})` : ""}</Text> : null}
    {rows.map(({ task: worker, depth }) => <View key={worker.id} style={{ marginLeft: depth * 10, gap: 3 }}>
      {!compact ? <>
        <Text style={{ color: theme.colors.foreground }}>{worker.description ?? worker.id} · {worker.status ?? "Unknown"}</Text>
        <Text style={{ color: theme.colors.foregroundMuted }}>{worker.id} · {[worker.agent, worker.model].filter(Boolean).join(" · ")}</Text>
      </> : null}
      {scope ? <Pressable accessibilityRole="button" accessibilityLabel={`Open output for ${worker.description ?? worker.id}`}
        onPress={() => setSelected(worker.id)} style={{ minHeight: 36, justifyContent: "center" }}>
        <Text style={{ color: theme.colors.accent }}>Open worker output</Text>
      </Pressable> : null}
    </View>)}
    {selectedTask ? <View style={{ gap: 6, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 6, padding: 8 }}>
      <Text style={{ color: theme.colors.foreground }}>Recorded output · {selectedTask.description ?? selectedTask.id}</Text>
      <Text style={{ color: theme.colors.foregroundMuted }}>Read only · recent assistant text and tool results</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Close worker output" onPress={() => setSelected(null)} style={{ minHeight: 36 }}>
        <Text style={{ color: theme.colors.foregroundMuted }}>Close output</Text>
      </Pressable>
      {query.isPending ? <Text style={{ color: theme.colors.foregroundMuted }}>Loading worker output…</Text> : null}
      {query.isError ? <Pressable accessibilityRole="button" accessibilityLabel="Retry reading worker output" onPress={() => void query.refetch()} style={{ minHeight: 36 }}>
        <Text style={{ color: theme.colors.statusWarning }}>Worker output could not be read. Retry</Text>
      </Pressable> : null}
      {query.data ? <>
        {query.data.warning ? <Text style={{ color: theme.colors.statusWarning }}>{query.data.warning}</Text> : null}
        {query.data.truncated ? <Text style={{ color: theme.colors.foregroundMuted }}>Showing a bounded excerpt of recent output.</Text> : null}
        <WorkerOutputView key={selectedTask.id} output={query.data} theme={theme} />
      </> : null}
    </View> : null}
  </View>;
}
