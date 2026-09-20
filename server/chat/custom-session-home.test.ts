import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { agentDagSnapshot } from "./publisher.js";
import { activeRuns } from "./active.js";
import { locateDag } from "../dag/dag.js";
import { getDagSnapshot } from "../dag/dag-store.js";
import { sdkContext } from "./sdk-context.test-support.js";

const roots: string[] = [];
const sessionId = "01a0be0f-ee78-7a1c-a36a-9059ba0aa2db";
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "omo-custom-session-home-"));
  roots.push(root);
  const cwd = join(root, "project");
  const sessionFile = join(root, "custom-agent", "sessions", "bucket", `2026-09-20_${sessionId}.jsonl`);
  vi.stubEnv("OMO_CODING_AGENT_DIR", join(root, "default-agent"));
  vi.stubEnv("PASEO_OMO_TASK_STATE_DIR", "");
  vi.stubEnv("OMO_HERDR_DAG_TASK_STATE_DIR", "");
  const sdk = sdkContext(cwd, sessionId);
  sdk.snapshot.runtimeInfo = { provider: "omo", sessionId: `omo ${JSON.stringify({ data: { sessionFile } })}` };
  async function header(id = sessionId, directory = cwd) {
    await mkdir(dirname(sessionFile), { recursive: true });
    await writeFile(sessionFile, JSON.stringify({ type: "session", id, cwd: directory, timestamp: "2026-09-20T00:00:00.000Z" }) + "\n");
  }
  const runFile = join(cwd, ".omo", "senpi-task", "dag", "runs", "dag_custom.json");
  await mkdir(dirname(runFile), { recursive: true });
  await writeFile(runFile, JSON.stringify({
    schemaVersion: 1, runId: "dag_custom", parentSessionId: sessionId,
    status: "running", updatedAt: new Date().toISOString(),
    nodes: [{ id: "a", state: "running" }], edges: [],
  }));
  return { cwd, sessionFile, sdk, header };
}

test("SDK snapshot and navigation verify the exact header outside the default OmO home", async () => {
  const f = await fixture();
  await f.header();
  await expect(getDagSnapshot({ cwd: f.cwd, sessionId })).rejects.toMatchObject({ code: "PASEO_SESSION_NOT_FOUND" });
  const snapshot = await agentDagSnapshot({ agentId: "agent-1" }, f.sdk.context);
  expect(snapshot.sessionId).toBe(sessionId);
  expect(snapshot.runs.map(run => run.id)).toEqual(["dag_custom"]);
  await expect(locateDag({ agentId: "agent-1", runId: "dag_custom" }, f.sdk.context)).resolves.toMatchObject({
    destination: { cwd: f.cwd, sessionId, runId: "dag_custom" },
  });
});

test.each(["missing", "foreign-id", "foreign-cwd"])("SDK path cannot authorize a %s header", async kind => {
  const f = await fixture();
  if (kind !== "missing") await f.header(kind === "foreign-id" ? "foreign" : sessionId, kind === "foreign-cwd" ? join(f.cwd, "other") : f.cwd);
  // Even a plausible run fallback must not bypass the authoritative header check.
  const file = join(f.cwd, ".omo", "senpi-task", "dag", "runs", "fallback.json");
  await writeFile(file, JSON.stringify({ schemaVersion: 1, runId: "fallback", parentSessionId: sessionId, cwd: f.cwd, status: "running", nodes: [], edges: [] }));
  await expect(agentDagSnapshot({ agentId: "agent-1" }, f.sdk.context)).rejects.toMatchObject({ code: "PASEO_SESSION_NOT_FOUND" });
  await expect(locateDag({ agentId: "agent-1" }, f.sdk.context)).rejects.toMatchObject({ code: "PASEO_SESSION_NOT_FOUND" });
});

test("active runs still use SDK identity without requiring a persisted header", async () => {
  const f = await fixture();
  const result = await activeRuns({ agentId: "agent-1" }, f.sdk.context);
  expect(result.rows.map(row => row.runId)).toEqual(["dag_custom"]);
});
