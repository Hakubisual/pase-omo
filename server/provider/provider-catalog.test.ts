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

/** Models the fake answers to `get_available_models`, consumed in order. */
const queued: Array<{ models: Array<{ id: string; provider: string; name: string }> }> = [];

/**
 * States the fake answers to `get_state`, consumed in order. An empty queue
 * means OmO named no model. This call rides the same spawn as the model list
 * and is not counted as a probe.
 */
const queuedStates: Array<{ model?: { provider: string; id: string } }> = [];

vi.mock("./omo-process.js", () => {
  class OmoProcess {
    private readonly record = { calls: 0 };
    start(): void {
      processes.push(this.record);
    }
    stop(): void {}
    async call(command: string) {
      // Only model listing is a probe. get_state rides the same spawn and must
      // not change the call counts the freshness cases assert.
      if (command === "get_available_models") {
        this.record.calls += 1;
        return queued.shift() ?? { models: [] };
      }
      if (command === "get_state") return queuedStates.shift() ?? {};
      throw new Error(`unexpected OmO command: ${command}`);
    }
  }
  return { OmoProcess };
});

const model = (provider: string, id: string) => ({ provider, id, name: `${provider}/${id}` });

let agentDir: string;
let previousAgentDir: string | undefined;
let previousCommand: string | undefined;

beforeEach(async () => {
  vi.resetModules();
  processes.length = 0;
  queued.length = 0;
  queuedStates.length = 0;
  agentDir = await mkdtemp(join(tmpdir(), "omo-catalog-"));
  previousAgentDir = process.env.OMO_CODING_AGENT_DIR;
  process.env.OMO_CODING_AGENT_DIR = agentDir;
  // OmoProcess is mocked above, so the CLI is never spawned; the launch only has
  // to resolve. Pinning it keeps the fingerprint under test the model config's
  // rather than whichever omo happens to be installed on the host, which is what
  // made these cases pass on a developer machine and fail on a clean checkout.
  previousCommand = process.env.PASEO_OMO_COMMAND;
  process.env.PASEO_OMO_COMMAND = JSON.stringify([join(agentDir, "omo-stub")]);
});

afterEach(() => {
  if (previousAgentDir === undefined) delete process.env.OMO_CODING_AGENT_DIR;
  else process.env.OMO_CODING_AGENT_DIR = previousAgentDir;
  if (previousCommand === undefined) delete process.env.PASEO_OMO_COMMAND;
  else process.env.PASEO_OMO_COMMAND = previousCommand;
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
  const catalogs: Array<{ ids: string[]; defaultModel: string | undefined }> = [];
  connection.onEvent((event) => {
    if (event.type !== "catalog") return;
    catalogs.push({
      ids: event.catalog.models.map((entry) => entry.id),
      defaultModel: event.catalog.defaultModel,
    });
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
      const answer = catalogs[catalogs.length - 1];
      if (!answer) throw new Error("catalog not answered yet");
      return answer.ids;
    },
    /** Default model advertised with the catalog answer just received. */
    defaultModel(): string | undefined {
      return catalogs[catalogs.length - 1]?.defaultModel;
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

describe("OmO catalog default", () => {
  it("advertises the model get_state names when it is not listed first", async () => {
    await rewriteModels('{"providers":{}}', 0);
    queued.push({
      models: [
        model("baseten", "deepseek-ai/DeepSeek-V4-Flash-0731"),
        model("anthropic-subscription", "claude-opus-5-5"),
      ],
    });
    // OmO lists every model it knows, so list order is not its default. A new
    // agent should start on the model get_state is already running.
    queuedStates.push({ model: { provider: "anthropic-subscription", id: "claude-opus-5-5" } });

    const session = await openConnection();
    expect(await session.request()).toEqual([
      "baseten/deepseek-ai/DeepSeek-V4-Flash-0731",
      "anthropic-subscription/claude-opus-5-5",
    ]);
    expect(session.defaultModel()).toBe("anthropic-subscription/claude-opus-5-5");
    await session.connection.close();
  });

  it("falls back to the first model when get_state names none or one absent from the catalog", async () => {
    await rewriteModels('{"providers":{}}', 0);
    const models = [
      model("baseten", "deepseek-ai/DeepSeek-V4-Flash-0731"),
      model("anthropic-subscription", "claude-opus-5-5"),
    ];
    const ids = [
      "baseten/deepseek-ai/DeepSeek-V4-Flash-0731",
      "anthropic-subscription/claude-opus-5-5",
    ];

    // No model is not a failed probe. The first entry is the default Paseo
    // advertised before OmO's own default was consulted.
    queued.push({ models });
    queuedStates.push({});
    const none = await openConnection();
    expect(await none.request()).toEqual(ids);
    expect(none.defaultModel()).toBe("baseten/deepseek-ai/DeepSeek-V4-Flash-0731");
    await none.connection.close();

    // A default OmO names but does not list cannot be selected, so the same
    // fallback applies.
    queued.push({ models });
    queuedStates.push({ model: { provider: "missing", id: "not-in-catalog" } });
    const absent = await openConnection();
    expect(await absent.request()).toEqual(ids);
    expect(absent.defaultModel()).toBe("baseten/deepseek-ai/DeepSeek-V4-Flash-0731");
    await absent.connection.close();
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

describe("stale OmO session models", () => {
  it("drops a model the current catalog no longer advertises when opening a session", async () => {
    const { sanitizeSessionModel } = await import("./provider.js");
    const catalog = [model("cliproxyapi-last", "gpt-6-luna")];

    expect(sanitizeSessionModel("local-proxy/gpt-5.6-sol", catalog)).toBeUndefined();
    expect(sanitizeSessionModel("cliproxyapi-last/gpt-6-luna", catalog)).toBe("cliproxyapi-last/gpt-6-luna");
    expect(sanitizeSessionModel(undefined, catalog)).toBeUndefined();

    const { createOmoProvider } = await import("./provider.js");
    queued.push({ models: catalog });
    const connection = await createOmoProvider().connect({ versions: [1], capabilities: [] });
    const openedConfigs: Array<{ model?: string }> = [];
    connection.onEvent((event) => {
      if (event.type === "session.config") openedConfigs.push(event.config);
    });
    await connection.send({
      type: "session.open",
      requestId: "stale-model-open",
      sessionId: "stale-model-session",
      history: "skip",
      config: {
        cwd: agentDir,
        env: {},
        mcpServers: {},
        settings: {},
        persist: false,
        model: "local-proxy/gpt-5.6-sol",
      },
    });
    await vi.waitFor(() => {
      if (openedConfigs.length === 0) throw new Error("session config not emitted yet");
    });
    expect(openedConfigs[0]?.model).toBeUndefined();
    await connection.close();
  });
});
