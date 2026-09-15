import { mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PROVIDER_ID } from "../../shared/ids.js";

/**
 * These tests drive OmO's real config directory rather than a mocked CLI, so a
 * change in how the plugin decides a catalog is stale surfaces as a wrong
 * answer instead of as a call-count assertion.
 */
const processes: Array<{ calls: number }> = [];

/** What the fake `omo --mode rpc` answers, consumed in order. */
const queued: Array<{ models: Array<{ id: string; provider: string; name: string }> }> = [];

vi.mock("./omo-process.js", () => {
  class OmoProcess {
    private readonly record = { calls: 0 };
    start(): void {
      processes.push(this.record);
    }
    stop(): void {}
    async call(): Promise<{ models: Array<{ id: string; provider: string; name: string }> }> {
      this.record.calls += 1;
      return queued.shift() ?? { models: [] };
    }
  }
  return { OmoProcess };
});

const model = (provider: string, id: string) => ({ provider, id, name: `${provider}/${id}` });

let agentDir: string;
let previousAgentDir: string | undefined;

beforeEach(async () => {
  vi.resetModules();
  processes.length = 0;
  queued.length = 0;
  agentDir = await mkdtemp(join(tmpdir(), "omo-catalog-"));
  previousAgentDir = process.env.OMO_CODING_AGENT_DIR;
  process.env.OMO_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
  if (previousAgentDir === undefined) delete process.env.OMO_CODING_AGENT_DIR;
  else process.env.OMO_CODING_AGENT_DIR = previousAgentDir;
});

/** Touch OmO's model config so the fingerprint moves. */
async function rewriteModels(contents: string, secondsFromNow: number): Promise<void> {
  const path = join(agentDir, "models.json");
  await writeFile(path, contents);
  const when = new Date(Date.now() + secondsFromNow * 1000);
  await utimes(path, when, when);
}

/**
 * A live provider connection plus the catalogs it has published.
 *
 * The catalog cache lives on the connection, so the reuse case has to send two
 * requests down one connection; opening a second connection is a different
 * question (the daemon's cache) and is exercised through the cache key instead.
 */
async function openConnection() {
  const { createOmoProvider } = await import("./provider.js");
  const connection = await createOmoProvider().connect({ versions: [1], capabilities: [] });
  const catalogs: string[][] = [];
  connection.onEvent((event) => {
    if (event.type === "catalog") catalogs.push(event.catalog.models.map((entry) => entry.id));
  });
  let seq = 0;
  return {
    connection,
    catalogs,
    /** Request the catalog and wait for the matching answer. */
    async request(): Promise<string[]> {
      const before = catalogs.length;
      seq += 1;
      await connection.send({ type: "catalog", requestId: `r${seq}`, cwd: agentDir });
      await vi.waitFor(() => {
        if (catalogs.length === before) throw new Error("catalog not answered yet");
      });
      return catalogs[catalogs.length - 1] as string[];
    },
  };
}

/** One catalog request on its own connection. */
async function requestCatalog(): Promise<string[]> {
  const session = await openConnection();
  const ids = await session.request();
  await session.connection.close();
  return ids;
}

describe("OmO catalog freshness", () => {
  it("lists a model registered while this connection was already live", async () => {
    await rewriteModels('{"providers":{}}', 0);
    const session = await openConnection();

    queued.push({ models: [model("cliproxyapi-opus", "claude-opus-5")] });
    expect(await session.request()).toEqual(["cliproxyapi-opus/claude-opus-5"]);

    // A model registered while the agent window stayed open must appear on the
    // next catalog request without restarting the daemon or the connection.
    await rewriteModels('{"providers":{"cliproxyapi-opus":{}}}', 5);
    queued.push({
      models: [model("cliproxyapi-opus", "claude-opus-5"), model("cliproxyapi-opus", "claude-opus-4-8")],
    });
    expect(await session.request()).toEqual([
      "cliproxyapi-opus/claude-opus-5",
      "cliproxyapi-opus/claude-opus-4-8",
    ]);
    await session.connection.close();
    // Both requests re-probed, and the first one was the only spawn before the edit.
    expect(processes.map((entry) => entry.calls)).toEqual([1, 1]);
  });

  it("reuses the catalog while the model config is unchanged", async () => {
    await rewriteModels('{"providers":{}}', 0);
    queued.push({ models: [model("commandcode", "deepseek/deepseek-v4.1-flash")] });
    const session = await openConnection();
    expect(await session.request()).toEqual(["commandcode/deepseek/deepseek-v4.1-flash"]);
    expect(await session.request()).toEqual(["commandcode/deepseek/deepseek-v4.1-flash"]);
    await session.connection.close();
    // One spawn total: the second request is served from the connection cache.
    expect(processes.filter((entry) => entry.calls > 0)).toHaveLength(1);
  });

  it("keys the daemon catalog cache on the model config, not only the CLI path", async () => {
    const { createOmoProvider } = await import("./provider.js");
    await rewriteModels('{"providers":{}}', 0);
    const first = await createOmoProvider().getCatalogCacheKey?.({ scope: "global" });
    expect(typeof first).toBe("string");

    await rewriteModels('{"providers":{"cliproxyapi-opus":{}}}', 30);
    const second = await createOmoProvider().getCatalogCacheKey?.({ scope: "global" });
    expect(second).not.toBe(first);
  });

  it("tracks the user-scope omo.jsonc, which sits above the agent directory", async () => {
    const { createOmoProvider } = await import("./provider.js");
    const userConfig = join(agentDir, "..", "omo.jsonc");
    await writeFile(userConfig, '{"categories":{}}');
    const before = await createOmoProvider().getCatalogCacheKey?.({ scope: "global" });

    // A category edit changes which models OmO reports, so the key must move
    // even though the agent directory itself is untouched.
    const later = new Date(Date.now() + 60_000);
    await writeFile(userConfig, '{"categories":{"opus-api":{}}}');
    await utimes(userConfig, later, later);
    const after = await createOmoProvider().getCatalogCacheKey?.({ scope: "global" });

    expect(after).not.toBe(before);
    expect(String(before)).toContain("omo.jsonc:");
    expect(String(before)).not.toContain("omo.jsonc:ENOENT");
  });
});

describe("OmO provider identity", () => {
  it("registers as omo so every OmO-matching surface agrees", async () => {
    const { createOmoProvider } = await import("./provider.js");
    // The client filters agents on `provider === "omo"` and the DAG pill on a
    // substring match, so a suffixed id would hide this provider's agents.
    expect(PROVIDER_ID).toBe("omo");
    expect(createOmoProvider().id).toBe("omo");
  });
});
