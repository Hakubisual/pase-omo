import { expect, it, vi } from "vitest";
import { PLUGIN_ID } from "../../shared/ids.js";
import { runWorkersCli } from "./cli.js";
import type { RpcPeer } from "./chat-bridge.js";

it("CLI routes explicit ownership and URL through the same plugin bridge", async () => {
  const peer: RpcPeer = { connect: vi.fn(async () => {}), close: vi.fn(async () => {}), invokePluginRpc: vi.fn(async () => ({ workers: [] })) };
  const createPeer = vi.fn(() => peer);
  expect(await runWorkersCli(["list", "--agentId", "agent", "--workspaceId", "workspace", "--url", "ws://127.0.0.1:6779/ws", "--home", "not-used-with-explicit-owner-and-url"], { createPeer })).toEqual({ workers: [] });
  expect(createPeer).toHaveBeenCalledWith("ws://127.0.0.1:6779/ws", 30_000);
  expect(peer.invokePluginRpc).toHaveBeenCalledWith(PLUGIN_ID, "workers.list", { agentId: "agent", workspaceId: "workspace" });
  expect(peer.close).toHaveBeenCalledOnce();
});
it.each([
  ["list"], ["list", "--agentId", "agent"],
  ["list", "--sessionId", "exact", "--agentId", "agent", "--workspaceId", "workspace"],
  ["cancel", "--agentId", "agent", "--workspaceId", "workspace"],
  ["list", "--agentId", "agent", "--workspaceId", "workspace", "--workers", "[]"],
])("rejects invalid CLI arguments before transport: %j", async (...args) => {
  const createPeer = vi.fn<() => RpcPeer>();
  await expect(runWorkersCli(args, { createPeer })).rejects.toThrow();
  expect(createPeer).not.toHaveBeenCalled();
});
