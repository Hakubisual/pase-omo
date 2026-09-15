import type { PluginCleanup } from "@getpaseo/plugin";
import type { PluginClientContext } from "@getpaseo/plugin/client";

import { ApprovalPanel } from "./client/approval-panel.js";
import { contributeApprovalPill } from "./client/approval-pill.js";
import { contributeDagPill } from "./client/dag-pill.js";
import { FoldersPanel } from "./client/folders-panel.js";
import { DagGlobalSurface, DagPanel } from "./client/dag.js";
import { DagRunRow } from "./client/dag-row.js";
import { contributeTodoClient } from "./client/todo-card.js";
import { contributeUpdateButton, OmoUpdatePanel } from "./client/update-button.js";
import {
  APPROVAL_PANEL_ID,
  DAG_PANEL_ID,
  DAG_SURFACE_ID,
  FOLDERS_PANEL_ID,
  UPDATE_PANEL_ID,
} from "./shared/ids.js";
import { DAG_ROW_KIND, DAG_ROW_VERSION, DagRowSchema } from "./shared/row.js";

/**
 * Single client entry for every OmO surface.
 *
 * This replaces four separately installed plugins (`omo`, `omo-dag`,
 * `omo-workers`, `omo-dag-chat`). Two of them registered the same panel id,
 * surface id and command id, so the app showed duplicate "OmO DAG" entries.
 * Each surface is registered exactly once here, and every registration handle
 * is released on cleanup rather than dropped.
 *
 * The worker surfaces the `omo-workers` plugin used to contribute are
 * deliberately absent: the user asked for the OmO worker UI to go away, so the
 * panel, its command and its per-agent pill are no longer registered and the
 * client module behind them was deleted. The daemon-side worker RPCs stay,
 * because the `paseo_workers` tool in extension/omo-tools.ts is their other
 * consumer and it never rendered anything.
 */
export default function contribute(client: PluginClientContext): PluginCleanup {
  const registrations: PluginCleanup[] = [];

  registrations.push(
    client.addWorkspacePanel({
      id: DAG_PANEL_ID,
      title: "OmO DAG",
      icon: "GitFork",
      context: "workspace",
      locations: ["workspace", "explorer"],
      Component: DagPanel,
    }),
    client.addWorkspacePanel({
      id: APPROVAL_PANEL_ID,
      title: "OmO Approvals",
      icon: "ShieldCheck",
      context: "agent",
      locations: ["workspace", "explorer"],
      Component: ApprovalPanel,
    }),
    client.addWorkspacePanel({
      id: FOLDERS_PANEL_ID,
      title: "OmO Folders",
      icon: "FolderTree",
      context: "workspace",
      locations: ["workspace", "explorer"],
      Component: FoldersPanel,
    }),
    client.addWorkspacePanel({
      id: UPDATE_PANEL_ID,
      title: "OmO 업데이트",
      icon: "RefreshCw",
      context: "workspace",
      locations: ["workspace", "explorer"],
      Component: OmoUpdatePanel,
    }),
    client.addSurface(DAG_SURFACE_ID, DagGlobalSurface),
    client.addSidebarItem({
      id: "omo-dag",
      title: "OmO DAG",
      icon: "GitFork",
      surface: DAG_SURFACE_ID,
    }),
    client.addCommandCenterItem({
      id: "open-dag-panel",
      title: "Open OmO DAG",
      icon: "GitFork",
      keywords: ["omo", "dag", "tasks", "subagents"],
      context: "workspace",
      onSelect({ openPanel }) {
        openPanel(DAG_PANEL_ID, { location: "workspace" });
      },
    }),
    client.addCommandCenterItem({
      id: "open-dag-explorer",
      title: "Open OmO DAG in Side Panel",
      icon: "PanelRight",
      keywords: ["omo", "dag", "explorer"],
      context: "workspace",
      onSelect({ openPanel }) {
        openPanel(DAG_PANEL_ID, { location: "explorer" });
      },
    }),
    client.addCommandCenterItem({
      id: "open-approvals-panel",
      title: "Open OmO Approvals",
      icon: "ShieldCheck",
      keywords: ["omo", "approval", "permission", "question", "approve"],
      context: "agent",
      onSelect({ openPanel }) {
        openPanel(APPROVAL_PANEL_ID, { location: "explorer" });
      },
    }),
    client.addCommandCenterItem({
      id: "omo-update",
      title: "OmO 업데이트 / 전체 세션 재시작",
      icon: "RefreshCw",
      keywords: ["omo", "update", "restart", "업데이트", "재시작", "세션"],
      context: "workspace",
      onSelect({ openPanel }) {
        openPanel(UPDATE_PANEL_ID, { location: "explorer" });
      },
    }),
    client.addCommandCenterItem({
      id: "open-folders-panel",
      title: "Open OmO Folders",
      icon: "FolderTree",
      keywords: ["omo", "folder", "sessions", "folders", "sessions"],
      context: "workspace",
      onSelect({ openPanel }) {
        openPanel(FOLDERS_PANEL_ID, { location: "explorer" });
      },
    }),
    client.addTimelineRenderer({
      kind: DAG_ROW_KIND,
      version: DAG_ROW_VERSION,
      schema: DagRowSchema,
      Component: DagRunRow,
    }),
    contributeDagPill(client),
    contributeUpdateButton(client),
    contributeApprovalPill(client),
    contributeTodoClient(client),
  );

  return () => {
    // Release in reverse so the per-agent pill loops stop before the surfaces
    // they open are torn down.
    for (const release of registrations.reverse()) release();
    registrations.length = 0;
  };
}
