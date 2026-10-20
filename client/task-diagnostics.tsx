import type { PluginTheme } from "@getpaseo/plugin";
import { Text, View } from "react-native";
import type { DagTask } from "../shared/dag.js";
import { relativeTime } from "./workflow-layout.js";

export function activityAge(task: DagTask | undefined, now = Date.now()): string {
  const at = task?.lastActivityAt ? Date.parse(task.lastActivityAt) : Number.NaN;
  if (!Number.isFinite(at) || at > now) return "Activity time not recorded";
  const elapsed = now - at;
  return elapsed >= 600_000
    ? `No recorded activity for ${Math.floor(elapsed / 60_000)}m`
    : `Last recorded activity ${relativeTime(at, now)}`;
}

/** Shared by board, cards and chat-popover inspectors. Counts are explicitly observed. */
export function TaskDiagnostics({ task, theme, hideTerminalReason = false }: { task: DagTask | undefined; theme: PluginTheme; hideTerminalReason?: boolean }) {
  if (!task) return null;
  const activity = task.lastActivityAt && Number.isFinite(Date.parse(task.lastActivityAt))
    ? new Date(task.lastActivityAt).toLocaleString() : undefined;
  return (
    <View style={{ gap: 6 }}>
      {task.terminalReason && !hideTerminalReason ? <Text style={{ color: theme.colors.foreground }}>{`Reason: ${task.terminalReason}`}</Text> : null}
      {task.observedToolCalls !== undefined && task.toolCalls === undefined
        ? <Text style={{ color: theme.colors.foregroundMuted }}>{`Observed tool calls: ${task.observedToolCalls}`}</Text> : null}
      {activity ? <Text style={{ color: theme.colors.foregroundMuted }}>{`Last recorded activity: ${activity}`}</Text> : null}
      {task.status === "running" ? <Text style={{ color: theme.colors.foregroundMuted }}>{activityAge(task)}</Text> : null}
      {task.lastTool ? <Text style={{ color: theme.colors.foregroundMuted }}>{`Last observed tool: ${task.lastTool}`}</Text> : null}
      {task.activityError ? <Text style={{ color: theme.colors.statusWarning }}>{task.activityError}</Text> : null}
    </View>
  );
}
