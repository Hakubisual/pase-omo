import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import extension, { registerWorkersTool, WorkersToolParams } from "../../extension/omo-tools.js";
import { PLUGIN_ID } from "../../shared/ids.js";
import type { RpcPeer } from "./chat-bridge.js";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "workers-tool-"));
  await mkdir(join(home, "agents", "project"), { recursive: true });
  await writeFile(join(home, "agents", "project", "parent.json"), JSON.stringify({
    id: "agent", workspaceId: "workspace", provider: "omo", persistence: { sessionId: "exact-session" },
  }));
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

function capture(options?: Parameters<typeof registerWorkersTool>[1]) {
  const api = { registerTool: vi.fn() };
  const tool = options ? registerWorkersTool(api, options) : extension(api);
  expect(api.registerTool).toHaveBeenCalledOnce();
  expect(api.registerTool).toHaveBeenCalledWith(tool);
  expect(tool.name).toBe("paseo_workers");
  return tool;
}
it("default extension registers typed parameters", () => {
  expect(capture().parameters).toBe(WorkersToolParams);
});
it("invokes the actual registered launch/list/cancel/get tool using current session metadata", async () => {
  const record = {
    id: "worker", agentId: "agent", workspaceId: "workspace", sessionId: "00000000-0000-4000-8000-000000000001",
    title: "task", prompt: "task", cwd: "repo", repoRoot: "repo", branch: "branch", dependsOn: [],
    status: "cancelled", createdAt: "2026-09-09T00:00:00.000Z",
  };
  const peer: RpcPeer = { connect: vi.fn(async () => {}), close: vi.fn(async () => {}),
    invokePluginRpc: vi.fn(async (_plugin, method) => method === "workers.cancel" || method === "workers.get" ? { worker: record } : { workers: [] }),
  };
  const tool = capture({ home, url: "ws://127.0.0.1:6779/ws", createPeer: () => peer });
  const getSessionId = vi.fn(() => "exact-session");
  const ctx = { sessionManager: { getSessionId } };
  const list = await tool.execute("call", { action: "list" }, undefined, undefined, ctx);
  expect(list.content).toEqual([{ type: "text", text: JSON.stringify({ workers: [] }) }]);
  await tool.execute("call", { action: "launch", repoRoot: "repo", workers: [{ id: "worker", title: "task", prompt: "task" }] }, undefined, undefined, ctx);
  await tool.execute("call", { action: "cancel", workerId: "worker" }, undefined, undefined, ctx);
  await tool.execute("call", { action: "get", workerId: "worker" }, undefined, undefined, ctx);
  expect(peer.invokePluginRpc).toHaveBeenNthCalledWith(1, PLUGIN_ID, "workers.list", { agentId: "agent", workspaceId: "workspace" });
  expect(peer.invokePluginRpc).toHaveBeenNthCalledWith(2, PLUGIN_ID, "workers.launch", { agentId: "agent", workspaceId: "workspace", repoRoot: "repo", workers: [{ id: "worker", title: "task", prompt: "task", dependsOn: [] }] });
  expect(peer.invokePluginRpc).toHaveBeenNthCalledWith(3, PLUGIN_ID, "workers.cancel", { agentId: "agent", workspaceId: "workspace", workerId: "worker" });
  expect(peer.invokePluginRpc).toHaveBeenNthCalledWith(4, PLUGIN_ID, "workers.get", { agentId: "agent", workspaceId: "workspace", workerId: "worker" });
  expect(getSessionId).toHaveBeenCalledTimes(4);
  expect(peer.close).toHaveBeenCalledTimes(4);
  getSessionId.mockReturnValue("unmapped-session");
  const error = await tool.execute("call", { action: "list" }, undefined, undefined, ctx);
  expect(error.details).toMatchObject({ error: { code: "SESSION_MAPPING" } });
  expect(peer.invokePluginRpc).toHaveBeenCalledTimes(4);
});
