import type { PluginTheme } from "@getpaseo/plugin";
import type {
  PluginAgentPanelProps,
  PluginButtonContentProps,
  PluginButtonRegistration,
  PluginClientContext,
  PluginHostProps,
  PluginWorkspacePanelProps,
} from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";

import { POPOVER_BOTTOM_INSET, popoverMaxHeight } from "./popover-layout.js";

import {
  applyOmoUpdateRpc,
  omoUpdateStatusRpc,
  type OmoUpdateJob,
  type OmoUpdateStatusPayload,
} from "../shared/update.js";

/**
 * Update checks hit the npm registry, so they run on a slow cadence and only
 * while a popover that shows the answer is open.
 */
const STATUS_REFRESH_MS = 15 * 60 * 1000;

/** While a job is running the same query is the progress feed. */
const JOB_REFRESH_MS = 1500;

const STATUS_QUERY_KEY = ["omo-update", "status"] as const;

export function updateButtonLabel(status: OmoUpdateStatusPayload | undefined): string | undefined {
  return status?.updateAvailable ? "업데이트" : undefined;
}

/** One line naming what the button would do, given what the check found. */
export function updateSummary(status: OmoUpdateStatusPayload | undefined): string {
  if (!status) return "OmO 버전을 확인하는 중…";
  if (status.updateAvailable) {
    return `새 버전 ${status.availableVersion} (설치됨 ${status.installedVersion})`;
  }
  if (status.installedVersion === null) return "설치된 OmO 버전을 읽지 못했다.";
  if (status.availableVersion === null) {
    return `설치됨 ${status.installedVersion} · 최신 버전 확인 실패`;
  }
  return `최신 버전 (${status.installedVersion})`;
}

export function isUpdateJobRunning(job: OmoUpdateJob | null | undefined): boolean {
  return job !== null && job !== undefined && job.phase !== "done" && job.phase !== "failed";
}

/**
 * What the job says about itself, in one line.
 *
 * The apply RPC returns as soon as the work starts - the daemon kills a plugin
 * call at 30 seconds and a global install takes longer - so this line, fed by
 * the status poll, is the only place the run reports progress and its outcome.
 */
export function jobText(job: OmoUpdateJob | null | undefined): string {
  if (!job) return "";
  if (job.phase === "suspending") return `세션 ${job.total || ""}개 정지 중…`.replace("  ", " ");
  if (job.phase === "installing") return "OmO 설치 중…";
  if (job.phase === "resuming") return `세션 재개 중 (${job.resumed}/${job.suspended})…`;

  const parts: string[] = [];
  if (job.installError) parts.push(`업데이트 실패: ${job.installError}`);
  else if (job.install) parts.push(`업데이트 완료${job.version ? ` (${job.version})` : ""}`);
  parts.push(`세션 ${job.resumed}개 재개`);
  if (job.failures.length > 0) parts.push(job.failures.join(" / "));
  return parts.join(" · ");
}

function createStyles(theme: PluginTheme, compact: boolean, windowHeight: number) {
  return StyleSheet.create({
    screen: {
      padding: compact ? 12 : 16,
      paddingBottom: (compact ? 12 : 16) + POPOVER_BOTTOM_INSET,
      gap: 12,
      maxHeight: popoverMaxHeight(compact, windowHeight),
    },
    title: { color: theme.colors.foreground, fontSize: compact ? 15 : 16, fontWeight: "600" },
    body: { color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 19 },
    command: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18 },
    actions: { gap: 8 },
    button: {
      minHeight: 44,
      justifyContent: "center",
      alignItems: "center",
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderRadius: 8,
      backgroundColor: theme.colors.accent,
    },
    secondary: {
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
    },
    disabled: { opacity: 0.5 },
    primaryText: { color: theme.colors.accentForeground, fontSize: 14, fontWeight: "600" },
    secondaryText: { color: theme.colors.foreground, fontSize: 14, fontWeight: "600" },
    result: { color: theme.colors.foreground, fontSize: 13, lineHeight: 19 },
    error: { color: theme.colors.statusDanger, fontSize: 13, lineHeight: 19 },
  });
}

/**
 * Version state plus the two buttons that act on it.
 *
 * Both actions stop every OmO session and start it again on the same session
 * file; the update action replaces the CLI in between, which is the only moment
 * no child is holding the files the installer rewrites.
 */
function OmoUpdateBody(props: {
  theme: PluginHostProps["theme"];
  layout: PluginHostProps["layout"];
  close?: () => void;
}) {
  const { theme, layout, close } = props;
  const fetchStatus = useRpc(omoUpdateStatusRpc);
  const applyUpdate = useRpc(applyOmoUpdateRpc);
  const queryClient = useQueryClient();
  const { height: windowHeight } = useWindowDimensions();
  const styles = useMemo(
    () => createStyles(theme, layout.compact, windowHeight),
    [theme, layout.compact, windowHeight],
  );

  const status = useQuery({
    queryKey: STATUS_QUERY_KEY,
    queryFn: () => fetchStatus({}),
    // Fast while a job is moving, idle otherwise: the same query doubles as the
    // progress feed for a run the button no longer waits on.
    refetchInterval: (query) =>
      isUpdateJobRunning(query.state.data?.job) ? JOB_REFRESH_MS : STATUS_REFRESH_MS,
  });

  const apply = useMutation({
    mutationFn: (install: boolean) => applyUpdate({ install }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: STATUS_QUERY_KEY });
    },
  });

  const data = status.data;
  const job = data?.job ?? null;
  const running = apply.isPending || isUpdateJobRunning(job);
  const sessionLine =
    data === undefined
      ? ""
      : data.liveSessions === 0
        ? "지금 열려 있는 OmO 세션이 없다."
        : `OmO 세션 ${data.liveSessions}개를 정지했다가 같은 대화로 다시 시작한다.`;

  const handleUpdate = useCallback(() => apply.mutate(true), [apply]);
  const handleRestart = useCallback(() => apply.mutate(false), [apply]);
  const handleClose = useCallback(() => close?.(), [close]);

  return (
    <ScrollView style={{ maxHeight: styles.screen.maxHeight }} contentContainerStyle={styles.screen}>
      <Text style={styles.title}>OmO 업데이트</Text>
      <Text style={styles.body}>{updateSummary(data)}</Text>
      {sessionLine ? <Text style={styles.body}>{sessionLine}</Text> : null}
      {data?.error ? <Text style={styles.error}>{data.error}</Text> : null}

      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="업데이트하고 모든 세션 재시작"
          disabled={running}
          style={[styles.button, running && styles.disabled]}
          onPress={handleUpdate}
        >
          <Text style={styles.primaryText}>
            {running ? "진행 중…" : "업데이트 후 전체 세션 재시작"}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="모든 세션 재시작"
          disabled={running}
          style={[styles.button, styles.secondary, running && styles.disabled]}
          onPress={handleRestart}
        >
          <Text style={styles.secondaryText}>전체 세션 재시작만</Text>
        </Pressable>
      </View>

      <Text style={styles.command}>{data?.installCommand ?? ""}</Text>

      {job ? <Text style={styles.result}>{jobText(job)}</Text> : null}
      {apply.error ? <Text style={styles.error}>{String(apply.error)}</Text> : null}

      {job && !running && close ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="닫기"
          style={[styles.button, styles.secondary]}
          onPress={handleClose}
        >
          <Text style={styles.secondaryText}>닫기</Text>
        </Pressable>
      ) : null}
    </ScrollView>
  );
}

/** The header button's popover. */
export function OmoUpdatePopover(props: PluginButtonContentProps) {
  return <OmoUpdateBody theme={props.theme} layout={props.layout} close={props.close} />;
}

/**
 * The same controls as a panel, for the command center and for a phone, where a
 * panel gets the height a popover anchored to the header does not.
 */
export function OmoUpdatePanel(props: PluginWorkspacePanelProps | PluginAgentPanelProps) {
  return <OmoUpdateBody theme={props.theme} layout={props.layout} />;
}

interface ListedWorkspace {
  id: string;
}

/**
 * `workspaces.list()` answers with `{ entries }` on this daemon, but the payload
 * shape has varied by version the same way `agents.list()` has. Normalize once.
 */
export function listedWorkspaces(payload: unknown): ListedWorkspace[] {
  const record = (payload ?? {}) as { entries?: readonly unknown[]; workspaces?: readonly unknown[] };
  const items: readonly unknown[] = Array.isArray(payload) ? payload : (record.entries ?? record.workspaces ?? []);
  const workspaces: ListedWorkspace[] = [];
  for (const item of items) {
    const candidate = (item as { workspace?: unknown })?.workspace ?? item;
    const workspace = candidate as { id?: unknown } | null;
    if (!workspace || typeof workspace.id !== "string") continue;
    workspaces.push({ id: workspace.id });
  }
  return workspaces;
}

/** Matches the pills: coalesce a burst of workspace updates into one refresh. */
const COALESCE_MS = 250;

/**
 * Header button that pauses every OmO session, applies an OmO update and starts
 * the sessions again.
 *
 * It lives in the workspace header rather than a panel because the action is
 * global: a user who sees OmO announce a new version should not have to find the
 * one agent tab that happens to host a panel to apply it. One registration per
 * workspace is what the host's header contribution takes, so this tracks the
 * workspace list the way the composer pills track the agent list.
 */
export function contributeUpdateButton(client: PluginClientContext): () => void {
  const buttons = new Map<string, PluginButtonRegistration>();
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let again = false;

  const sync = async (): Promise<void> => {
    if (disposed) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      const workspaces = listedWorkspaces(await client.paseo.workspaces.list());
      if (disposed) return;
      const seen = new Set<string>();
      for (const workspace of workspaces) {
        seen.add(workspace.id);
        if (buttons.has(workspace.id)) continue;
        buttons.set(
          workspace.id,
          client.addHeaderButton({
            id: "omo-update",
            workspaceId: workspace.id,
            button: {
              title: "OmO 업데이트",
              icon: "RefreshCw",
              behavior: { kind: "popover", Content: OmoUpdatePopover },
            },
          }),
        );
      }
      for (const [workspaceId, button] of buttons) {
        if (seen.has(workspaceId)) continue;
        button.remove();
        buttons.delete(workspaceId);
      }
    } catch (error) {
      console.error("[omo-update] header button refresh failed", error);
    } finally {
      running = false;
      if (again && !disposed) {
        again = false;
        schedule();
      }
    }
  };

  function schedule(): void {
    if (disposed || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void sync();
    }, COALESCE_MS);
  }

  const unsubscribe = client.paseo.workspaces.subscribe(() => {
    schedule();
  });

  void sync();

  return () => {
    disposed = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    unsubscribe();
    for (const button of buttons.values()) button.remove();
    buttons.clear();
  };
}
