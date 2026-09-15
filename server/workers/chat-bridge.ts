import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { z } from "zod";
import { PLUGIN_ID } from "../../shared/ids.js";
import { cancelWorkerRpc, getWorkerRpc, launchWorkersRpc, listWorkersRpc, WorkerItemSpecSchema } from "../../shared/workers.js";

const text = z.string().min(1);
export const WorkerRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("launch"), repoRoot: text, workers: z.array(WorkerItemSpecSchema).min(1) }).strict(),
  z.object({ action: z.literal("list") }).strict(),
  z.object({ action: z.literal("cancel"), workerId: text }).strict(),
  z.object({ action: z.literal("get"), workerId: text }).strict(),
]);
export type WorkerRequest = z.input<typeof WorkerRequestSchema>;
export type WorkerOwner = { sessionId: string } | { agentId: string; workspaceId: string };
export interface RpcPeer {
  connect(): Promise<void>;
  invokePluginRpc(pluginId: string, method: string, input: unknown): Promise<unknown>;
  close(): Promise<void>;
}
export interface BridgeOptions {
  /** Paseo data directory, not the user's home directory. */
  home?: string;
  url?: string;
  timeoutMs?: number;
  signal?: AbortSignal | undefined;
  createPeer?: (url: string, timeoutMs: number) => RpcPeer;
}
export class BridgeError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BridgeError";
  }
}
const MetadataSchema = z.object({
  id: text, workspaceId: text.optional(), provider: z.string(),
  runtimeInfo: z.object({ sessionId: z.string().optional() }).nullish(),
  persistence: z.object({ sessionId: z.string().optional() }).nullish(),
  config: z.object({ model: text.optional() }).optional(),
});

export async function resolveSessionOwner(home: string, sessionId: string) {
  text.parse(sessionId);
  const root = join(home, "agents");
  const matches: z.infer<typeof MetadataSchema>[] = [];
  // Directory order and timestamps have no authority over session ownership.
  for (const directory of await readdir(root, { withFileTypes: true })) {
    if (!directory.isDirectory()) continue;
    for (const file of await readdir(join(root, directory.name), { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith(".json")) continue;
      const metadata = MetadataSchema.parse(JSON.parse(await readFile(join(root, directory.name, file.name), "utf8")));
      if (metadata.provider === "omo" &&
          (metadata.runtimeInfo?.sessionId === sessionId || metadata.persistence?.sessionId === sessionId)) matches.push(metadata);
    }
  }
  const [match] = matches;
  if (matches.length !== 1 || !match) throw new BridgeError("SESSION_MAPPING", `Expected one persisted OmO agent for the exact session; found ${matches.length}`);
  if (!match.workspaceId) throw new BridgeError("SESSION_MAPPING", "Matched agent has no workspaceId");
  return { agentId: match.id, workspaceId: match.workspaceId, model: match.config?.model };
}

export async function resolveDaemonUrl(home: string, explicit?: string): Promise<string> {
  let endpoint = explicit;
  if (endpoint === undefined) {
    const config = z.object({ daemon: z.object({ listen: text.optional() }).optional() })
      .parse(JSON.parse(await readFile(join(home, "config.json"), "utf8")));
    endpoint = config.daemon?.listen ?? "127.0.0.1:6767";
  }
  if (/^\d+$/.test(endpoint)) endpoint = `127.0.0.1:${endpoint}`;
  if (!/^(wss?|https?):\/\//.test(endpoint)) endpoint = `ws://${endpoint}`;
  let url: URL;
  try { url = new URL(endpoint); }
  catch { throw new BridgeError("ENDPOINT", "Invalid daemon TCP endpoint; supply --url ws://host:port/ws"); }
  if (url.username || url.password || url.search || url.hash || !["ws:", "wss:", "http:", "https:"].includes(url.protocol)) {
    throw new BridgeError("ENDPOINT", "Use a TCP URL without credentials, query, or fragment; authentication uses PASEO_PASSWORD");
  }
  url.protocol = url.protocol === "https:" || url.protocol === "wss:" ? "wss:" : "ws:";
  if (url.hostname === "0.0.0.0") url.hostname = "127.0.0.1";
  if (url.hostname === "[::]") url.hostname = "[::1]";
  if (url.pathname === "/") url.pathname = "/ws";
  return url.toString();
}

function defaultPeer(url: string, timeoutMs: number): RpcPeer {
  return new DaemonClient({
    url, clientId: `omo-workers-${randomUUID()}`, clientType: "cli",
    connectTimeoutMs: timeoutMs, reconnect: { enabled: false },
    ...(process.env.PASEO_PASSWORD ? { password: process.env.PASEO_PASSWORD } : {}),
  });
}

async function bounded<T>(operation: () => Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw new BridgeError("ABORTED", "Paseo workers request aborted");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const interrupted = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BridgeError("TIMEOUT", "Paseo workers request timed out; its backend outcome may be unknown")), timeoutMs);
    abort = () => reject(new BridgeError("ABORTED", "Paseo workers request aborted; its backend outcome may be unknown"));
    signal?.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([operation(), interrupted]); }
  finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
  }
}

export async function invokeWorkers(request: WorkerRequest, owner: WorkerOwner, options: BridgeOptions = {}): Promise<unknown> {
  const parsed = WorkerRequestSchema.parse(request);
  const timeoutMs = z.number().int().min(1).max(300_000).parse(options.timeoutMs ?? 30_000);
  const home = options.home ?? process.env.PASEO_HOME ?? join(homedir(), ".paseo");
  if (options.signal?.aborted) throw new BridgeError("ABORTED", "Paseo workers request aborted");
  const resolved = "sessionId" in owner
    ? await resolveSessionOwner(home, owner.sessionId)
    : z.object({ agentId: text, workspaceId: text }).strict().parse(owner);
  const identity = { agentId: resolved.agentId, workspaceId: resolved.workspaceId };
  const contract = { launch: launchWorkersRpc, list: listWorkersRpc, cancel: cancelWorkerRpc, get: getWorkerRpc }[parsed.action];
  const input = contract.input.parse(parsed.action === "launch"
    ? { ...identity, repoRoot: parsed.repoRoot, workers: parsed.workers.map(worker => ({
        ...worker,
        ...(!worker.model && "model" in resolved && resolved.model ? { model: resolved.model } : {}),
      })) }
    : { ...identity, ...("workerId" in parsed ? { workerId: parsed.workerId } : {}) });
  const url = await resolveDaemonUrl(home, options.url);
  if (options.signal?.aborted) throw new BridgeError("ABORTED", "Paseo workers request aborted");
  const peer = (options.createPeer ?? defaultPeer)(url, timeoutMs);
  let finished = false;
  let failure: BridgeError | undefined;
  let output: unknown;
  try {
    output = await bounded(async () => {
      await peer.connect();
      // Never send a mutating RPC after an aborted or timed-out connection.
      if (finished || options.signal?.aborted) throw new BridgeError("ABORTED", "Request ended before connection completed");
      return contract.output.parse(await peer.invokePluginRpc(PLUGIN_ID, contract.name, input));
    }, timeoutMs, options.signal);
  } catch (error) {
    failure = error instanceof BridgeError ? error : new BridgeError("RPC_FAILED", "Paseo workers RPC failed", { cause: error });
  }
  finished = true;
  try { await bounded(() => peer.close(), Math.min(timeoutMs, 5_000)); }
  catch (error) {
    throw new BridgeError("CLEANUP_FAILED", failure ? "Paseo workers request and connection cleanup failed" : "Paseo connection cleanup failed", { cause: new AggregateError(failure ? [failure, error] : [error]) });
  }
  if (failure) throw failure;
  return output;
}

export function bridgeErrorJson(error: unknown) {
  return { error: { code: error instanceof BridgeError ? error.code : "INVALID_REQUEST", message: error instanceof BridgeError ? error.message : "Invalid workers request or persisted Paseo metadata" } };
}
