import { useQuery } from "@tanstack/react-query";
import type { PluginTheme } from "@getpaseo/plugin";
import {
  useRpc,
  useWorkspace,
  type PluginAgentPanelProps,
  type PluginWorkspacePanelProps,
} from "@getpaseo/plugin/client";
import { useCallback, useMemo, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import { getSnapshotRpc, listSessionsRpc, type DagSession } from "../shared/dag.js";
import { FolderBrowser } from "./folders-browser.js";
import { buildFolderTree, defaultExpanded, folderKey, toggleFolder } from "./folders.js";

function createStyles(theme: PluginTheme, compact: boolean) {
  return StyleSheet.create({
    panel: { flex: 1, padding: compact ? 8 : 12, gap: 8 },
    hint: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18 },
  });
}

/**
 * Folder view over this project's OmO sessions, their DAG runs and the parallel
 * agents underneath them.
 *
 * Only the session the user opens is fetched: the daemon holds one snapshot per
 * session and loading all of them to draw a closed folder would make opening the
 * panel cost as much as opening every session in it.
 */
export function FoldersPanel(props: PluginWorkspacePanelProps | PluginAgentPanelProps) {
  const { theme, layout, workspaceId } = props;
  const styles = useMemo(() => createStyles(theme, layout.compact), [theme, layout.compact]);
  const cwd =
    useWorkspace(workspaceId, (workspace) => workspace.directory || workspace.projectRootPath) ?? "";

  const listSessions = useRpc(listSessionsRpc);
  const getSnapshot = useRpc(getSnapshotRpc);

  const sessionsQuery = useQuery({
    queryKey: ["dag", "folders", "sessions", cwd],
    queryFn: () => listSessions({ cwd }),
    enabled: cwd.length > 0,
  });
  const sessions: DagSession[] = sessionsQuery.data?.sessions ?? [];

  const [openSessionId, setOpenSessionId] = useState<string | null>(null);
  const snapshotQuery = useQuery({
    queryKey: ["dag", "folders", "snapshot", cwd, openSessionId],
    queryFn: () => getSnapshot({ cwd, sessionId: openSessionId ?? "" }),
    enabled: cwd.length > 0 && openSessionId !== null,
  });

  const tree = useMemo(
    () =>
      buildFolderTree(
        sessions,
        snapshotQuery.data?.runs ?? [],
        snapshotQuery.data?.tasks ?? [],
        // Without the scope the loaded snapshot files under an unnamed group
        // instead of the session it belongs to.
        openSessionId === null ? {} : { sessionId: openSessionId },
      ),
    [sessions, snapshotQuery.data, openSessionId],
  );

  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set([folderKey.root]));
  const handleToggle = useCallback(
    (key: string) => {
      setExpanded((current) => toggleFolder(current, key));
      // A session folder loads its own contents the first time it is opened.
      const session = sessions.find((candidate) => key.includes(candidate.id));
      if (session !== undefined) setOpenSessionId(session.id);
    },
    [sessions],
  );

  const handleOpenSession = useCallback((sessionId: string) => {
    setOpenSessionId(sessionId);
    setExpanded((current) => (defaultExpanded(tree).has(sessionId) ? current : current));
  }, [tree]);

  return (
    <View style={styles.panel}>
      <FolderBrowser
        tree={tree}
        expanded={expanded}
        theme={theme}
        layout={layout}
        onToggle={handleToggle}
        onOpenSession={handleOpenSession}
      />
      {cwd.length === 0 ? (
        <Text style={styles.hint}>No project path found for this workspace.</Text>
      ) : null}
    </View>
  );
}
