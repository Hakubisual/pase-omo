import type { PaseoAgent, PaseoAgentHandle } from "@getpaseo/client";
import type { PluginHookContext } from "@getpaseo/plugin/server";
import { vi } from "vitest";

/** Only the SDK methods these handlers use are implemented; identity comes from fetch snapshots. */
export function sdkContext(cwd: string, sessionId: string | null = "sess-1") {
  const snapshot: PaseoAgent = {
    id: "agent-1", provider: "omo", cwd, workspaceId: "wks-1", model: null,
    createdAt: "2026-09-15T00:00:00.000Z", updatedAt: "2026-09-15T00:00:00.000Z",
    lastUserMessageAt: null, status: "idle", currentModeId: null, availableModes: [],
    pendingPermissions: [], persistence: null, title: null, labels: {},
    capabilities: {
      supportsStreaming: true, supportsSessionPersistence: true, supportsDynamicModes: false,
      supportsMcpServers: false, supportsReasoningStream: true, supportsToolInvocations: true,
    },
  };
  const setSessionId = (id: string | null) => {
    snapshot.runtimeInfo = {
      provider: "omo",
      sessionId: id === null ? null : `omo ${JSON.stringify({ data: { sessionFile: `/sessions/2026-09-15T00-00-00_${id}.jsonl` } })}`,
    };
  };
  setSessionId(sessionId);
  const refresh = vi.fn<PaseoAgentHandle["refresh"]>(async () => ({ agent: snapshot, project: null }));
  const append = vi.fn<PaseoAgentHandle["timeline"]["append"]>(async () => ({ seq: 1, epoch: "epoch-1" }));
  const ref = vi.fn((agentId: string) => {
    if (agentId !== snapshot.id) throw new Error(`Unexpected agent lookup: ${agentId}`);
    return { refresh, timeline: { append } };
  });
  const context = {
    paseo: { agents: { ref } },
    signal: new AbortController().signal,
  } as unknown as PluginHookContext;
  return { context, snapshot, setSessionId, refresh, append, ref };
}
