import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import type { DagRow } from "../shared/row";
import { DagGraph } from "./graph";

export function DagRunRow({ item, theme, layout, agentId }: PluginTimelineItemProps<DagRow>) {
  return <DagGraph row={item.data} theme={theme} compact={layout.compact} agentId={agentId} />;
}
