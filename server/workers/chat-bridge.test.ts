import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLUGIN_ID } from "../../shared/ids.js";
import { invokeWorkers, resolveDaemonUrl, resolveSessionOwner, type RpcPeer } from "./chat-bridge.js";

let home: string;
const owner = { agentId: "parent", workspaceId: "workspace" };
const metadata = { id: "parent", workspaceId: "workspace", provider: "omo", runtimeInfo: { sessionId: "exact" }, config: { model: "provider/actual-model" } };
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "workers-bridge-"));
  await mkdir(join(home, "agents", "project"), { recursive: true });
  await writeFile(join(home, "config.json"), JSON.stringify({ daemon: { listen: "127.0.0.1:6779" } }));
  await writeFile(join(home, "agents", "project", "parent.json"), JSON.stringify(metadata));
});
afterEach(async () => { vi.useRealTimers(); await rm(home, { recursive: true, force: true }); });
function peer(): RpcPeer & { connect: ReturnType<typeof vi.fn<() => Promise<void>>>; invokePluginRpc: ReturnType<typeof vi.fn<RpcPeer["invokePluginRpc"]>>; close: ReturnType<typeof vi.fn<() => Promise<void>>> } {
  return { connect: vi.fn(async () => {}), invokePluginRpc: vi.fn(async () => ({ workers: [] })), close: vi.fn(async () => {}) };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
describe("exact persisted ownership", () => {
  it("ignores newer unrelated sessions and uses persistence after runtime is absent", async () => {
    await writeFile(join(home, "agents", "project", "newest.json"), JSON.stringify({ ...metadata, id: "newest", runtimeInfo: { sessionId: "other" }, updatedAt: "2099-01-01" }));
    expect(await resolveSessionOwner(home, "exact")).toEqual({ ...owner, model: "provider/actual-model" });
    await writeFile(join(home, "agents", "project", "parent.json"), JSON.stringify({ ...metadata, runtimeInfo: null, persistence: { sessionId: "exact" } }));
    expect(await resolveSessionOwner(home, "exact")).toMatchObject(owner);
  });
  it("rejects unknown, ambiguous, and workspace-less sessions", async () => {
    await expect(resolveSessionOwner(home, "missing")).rejects.toMatchObject({ code: "SESSION_MAPPING" });
    await writeFile(join(home, "agents", "project", "duplicate.json"), JSON.stringify({ ...metadata, id: "duplicate" }));
    await expect(resolveSessionOwner(home, "exact")).rejects.toMatchObject({ code: "SESSION_MAPPING" });
    await rm(join(home, "agents", "project", "duplicate.json"));
    await writeFile(join(home, "agents", "project", "parent.json"), JSON.stringify({ ...metadata, workspaceId: undefined }));
    await expect(resolveSessionOwner(home, "exact")).rejects.toMatchObject({ code: "SESSION_MAPPING" });
  });
});
it("normalizes config and explicit endpoints without accepting URL secrets", async () => {
  expect(await resolveDaemonUrl(home)).toBe("ws://127.0.0.1:6779/ws");
  expect(await resolveDaemonUrl(home, "https://localhost:7000")).toBe("wss://localhost:7000/ws");
  await expect(resolveDaemonUrl(home, "ws://user:secret@localhost:7000")).rejects.toMatchObject({ code: "ENDPOINT" });
});
it("inherits only the persisted parent model and preserves explicit worker models", async () => {
  const rpc = peer();
  await invokeWorkers({ action: "launch", repoRoot: "repo", workers: [
    { id: "a", title: "A", prompt: "task" }, { id: "b", title: "B", prompt: "task", model: "override", dependsOn: ["a"] },
  ] }, { sessionId: "exact" }, { home, createPeer: () => rpc });
  expect(rpc.invokePluginRpc).toHaveBeenCalledWith(PLUGIN_ID, "workers.launch", {
    ...owner, repoRoot: "repo", workers: [
      { id: "a", title: "A", prompt: "task", model: "provider/actual-model", dependsOn: [] },
      { id: "b", title: "B", prompt: "task", model: "override", dependsOn: ["a"] },
    ],
  });
  expect(rpc.close).toHaveBeenCalledOnce();
});
it("cleans up invalid responses and connection failures", async () => {
  const rpc = peer();
  rpc.invokePluginRpc.mockResolvedValue({ bad: true });
  await expect(invokeWorkers({ action: "list" }, owner, { home, createPeer: () => rpc })).rejects.toMatchObject({ code: "RPC_FAILED" });
  rpc.connect.mockRejectedValue(new Error("connection failed"));
  await expect(invokeWorkers({ action: "list" }, owner, { home, createPeer: () => rpc })).rejects.toMatchObject({ code: "RPC_FAILED" });
  expect(rpc.close).toHaveBeenCalledTimes(2);
});
it("aborts an in-flight RPC and closes its connection", async () => {
  const rpc = peer();
  const entered = deferred();
  const controller = new AbortController();
  rpc.invokePluginRpc.mockImplementation(() => { entered.resolve(); return new Promise(() => {}); });
  const result = invokeWorkers({ action: "list" }, owner, { home, signal: controller.signal, createPeer: () => rpc });
  const assertion = expect(result).rejects.toMatchObject({ code: "ABORTED" });
  await entered.promise;
  controller.abort();
  await assertion;
  expect(rpc.close).toHaveBeenCalledOnce();
});
it("bounds connect and never invokes RPC when a timed-out connect later resolves", async () => {
  vi.useFakeTimers();
  const rpc = peer();
  const entered = deferred();
  const connected = deferred();
  rpc.connect.mockImplementation(() => { entered.resolve(); return connected.promise; });
  const result = invokeWorkers({ action: "list" }, owner, { home, timeoutMs: 100, createPeer: () => rpc });
  const assertion = expect(result).rejects.toMatchObject({ code: "TIMEOUT" });
  await entered.promise;
  await vi.advanceTimersByTimeAsync(100);
  await assertion;
  connected.resolve();
  await connected.promise;
  expect(rpc.invokePluginRpc).not.toHaveBeenCalled();
  expect(rpc.close).toHaveBeenCalledOnce();
});
