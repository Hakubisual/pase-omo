import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { bridgeErrorJson, invokeWorkers, WorkerRequestSchema, type BridgeOptions, type WorkerOwner } from "./chat-bridge.js";

export const CLI_USAGE = `Usage: bun cli.server.ts <launch|list|cancel|get> [options]
Owner (required): --sessionId <exact-omo-session-id> OR --agentId <id> --workspaceId <id>
Launch: --repoRoot <path> --workers <JSON-array> OR --workers-file <JSON-file>
Cancel/get: --workerId <id>
Connection: --home <paseo-data-directory> --url <ws://host:port/ws> --timeoutMs <milliseconds>
Authentication: PASEO_PASSWORD environment variable (never printed).
`;

export async function runWorkersCli(argv: string[], options: Pick<BridgeOptions, "createPeer" | "signal"> = {}): Promise<unknown> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
    sessionId: { type: "string" }, agentId: { type: "string" }, workspaceId: { type: "string" },
    repoRoot: { type: "string" }, workers: { type: "string" }, "workers-file": { type: "string" },
    workerId: { type: "string" }, home: { type: "string" }, url: { type: "string" }, timeoutMs: { type: "string" },
  } });
  if (positionals.length !== 1) throw new Error("Exactly one action is required");
  let owner: WorkerOwner;
  if (values.sessionId && !values.agentId && !values.workspaceId) owner = { sessionId: values.sessionId };
  else if (!values.sessionId && values.agentId && values.workspaceId) owner = { agentId: values.agentId, workspaceId: values.workspaceId };
  else throw new Error("Supply an exact sessionId or both agentId and workspaceId");
  if (values.workers !== undefined && values["workers-file"] !== undefined) throw new Error("Choose workers or workers-file");
  const workersJson = values["workers-file"] !== undefined ? await readFile(values["workers-file"], "utf8") : values.workers;
  const request = WorkerRequestSchema.parse({
    action: positionals[0],
    ...(values.repoRoot !== undefined ? { repoRoot: values.repoRoot } : {}),
    ...(values.workerId !== undefined ? { workerId: values.workerId } : {}),
    ...(workersJson !== undefined ? { workers: JSON.parse(workersJson) } : {}),
  });
  return invokeWorkers(request, owner, {
    ...options,
    ...(values.home !== undefined ? { home: values.home } : {}),
    ...(values.url !== undefined ? { url: values.url } : {}),
    ...(values.timeoutMs !== undefined ? { timeoutMs: Number(values.timeoutMs) } : {}),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.slice(2).includes("--help")) process.stdout.write(CLI_USAGE);
  else {
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    try { process.stdout.write(`${JSON.stringify(await runWorkersCli(process.argv.slice(2), { signal: controller.signal }))}\n`); }
    catch (error) { process.stderr.write(`${JSON.stringify(bridgeErrorJson(error))}\n`); process.exitCode = 1; }
    finally { process.removeListener("SIGINT", abort); process.removeListener("SIGTERM", abort); }
  }
}
