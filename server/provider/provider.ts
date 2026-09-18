import {
  negotiateProviderCapabilities,
  requireProviderCapabilities,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
  type ProviderRegistration,
  type ProviderSessionSummary,
} from "@getpaseo/plugin/server/provider";
import { PROVIDER_ID, PROVIDER_LABEL } from "../../shared/ids.js";
import { type OmoLaunch, modelConfigFingerprint, resolveOmoLaunch } from "./omo-cli.js";
import { OmoProcess } from "./omo-process.js";
import {
  allThinkingOptions,
  describe,
  OMO_MODES,
  OmoSession,
  type OmoModelRecord,
  toProviderModels,
} from "./omo-session.js";
import { readSessionHeaders, sameCwd, sessionsDir } from "./omo-store.js";

const CAPABILITIES = [
  "prompt.message",
  "prompt.command",
  "prompt.image",
  "prompt.steer",
  "session.configure",
  "session.list",
  "session.persistence",
  // Child sessions for `task()` runs. The daemon rejects a child whose parent
  // did not negotiate this - "Provider parent session did not negotiate
  // session.subsession" - so the subagent rows depend on it being offered here.
  "session.subsession",
  "permission",
] as const;

function log(message: string): void {
  console.log(`[omo] ${message}`);
}

/**
 * Catalog discovery needs a live OmO; spawn a short-lived one and ask it.
 *
 * `fingerprint` is the model-config identity the answer belongs to. It is
 * captured before the CLI starts and returned with the models so a caller can
 * tell whether the catalog it holds still describes the config on disk: a probe
 * that raced an edit would otherwise be stored as if it were current.
 */
async function probeCatalog(
  launch: OmoLaunch,
  cwd: string,
  fingerprint: string | undefined,
): Promise<{ models: OmoModelRecord[]; fingerprint: string | undefined }> {
  const proc = new OmoProcess({
    launch,
    args: ["--mode", "rpc", "--no-session"],
    cwd,
    env: { ...(process.env as Record<string, string>), NO_COLOR: "1" },
    onEvent: () => {},
    onExit: () => {},
  });
  proc.start();
  try {
    const data = await proc.call<{ models: OmoModelRecord[] }>("get_available_models", {}, 240_000);
    return { models: data.models ?? [], fingerprint };
  } finally {
    proc.stop();
  }
}

export function createOmoProvider(): ProviderRegistration {
  return {
    id: PROVIDER_ID,
    label: PROVIDER_LABEL,
    description: "OmO (oh-my-openagent) running as a native Paseo agent",
    icon: "icon.svg",
    // The launch path alone is not a catalog identity: adding a model to OmO's
    // own config changes the answer the CLI gives without changing how the CLI
    // is invoked. Folding in the model config's fingerprint makes the key move
    // when the models do, which is what makes the daemon re-ask instead of
    // reusing a catalog that no longer matches omo.json / models.json.
    async getCatalogCacheKey() {
      try {
        const launch = resolveOmoLaunch();
        const fingerprint = await modelConfigFingerprint();
        return `${launch.command}|${launch.base.join(" ")}|${fingerprint}`;
      } catch {
        return undefined;
      }
    },
    async connect(request) {
      if (!request.versions.includes(1)) throw new Error("Provider protocol version 1 is required");
      return createOmoConnection(negotiateProviderCapabilities(request.capabilities, CAPABILITIES));
    },
  };
}

function createOmoConnection(capabilities: readonly string[]): ProviderConnection {
  const listeners = new Set<(event: ProviderEvent) => void>();
  const sessions = new Map<string, OmoSession>();
  let catalog: OmoModelRecord[] | undefined;
  /** Model-config identity the cached `catalog` was discovered under. */
  let catalogFingerprint: string | undefined;
  let closed = false;

  const emit = (event: ProviderEvent): void => {
    if (closed) return;
    for (const listener of listeners) listener(event);
  };

  const fail = (requestId: string, error: unknown): void => {
    emit({ type: "request.failed", requestId, error: { message: describe(error) } });
  };

  async function handleCatalog(input: Extract<ProviderInput, { type: "catalog" }>): Promise<void> {
    const launch = resolveOmoLaunch();
    // Re-probe whenever the model config moved under us. Paseo may or may not
    // treat the changed cache key as a reason to ask again, so the provider
    // cannot rely on it: consulting the fingerprint here is what guarantees a
    // freshly started agent window lists the models OmO currently registers.
    const fingerprint = await modelConfigFingerprint();
    if (!catalog || catalogFingerprint !== fingerprint) {
      const probed = await probeCatalog(launch, input.cwd ?? process.cwd(), fingerprint);
      catalog = probed.models;
      catalogFingerprint = probed.fingerprint;
    }
    const models = toProviderModels(catalog);
    emit({
      type: "catalog",
      requestId: input.requestId,
      catalog: {
        models,
        modes: OMO_MODES.map((mode) => ({ ...mode })),
        thinkingOptions: allThinkingOptions(models),
        ...(models[0] ? { defaultModel: models[0].id } : {}),
        defaultMode: "default",
      },
    });
  }

  async function handleSessions(input: Extract<ProviderInput, { type: "sessions" }>): Promise<void> {
    const headers = await readSessionHeaders(sessionsDir());
    const query = input.query?.trim().toLowerCase();
    const summaries: ProviderSessionSummary[] = headers
      .filter((header) => !header.child)
      .filter((header) => (input.cwd ? sameCwd(header.cwd, input.cwd) : true))
      .filter((header) => (query ? (header.name ?? header.id).toLowerCase().includes(query) : true))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, input.limit ?? 50)
      .map((header) => ({
        persistence: { version: 1, data: { sessionFile: header.file } },
        cwd: header.cwd,
        ...(header.name ? { title: header.name } : {}),
        updatedAt: header.updatedAt,
      }));
    emit({ type: "sessions", requestId: input.requestId, sessions: summaries });
  }

  async function handleOpen(input: Extract<ProviderInput, { type: "session.open" }>): Promise<void> {
    const launch = resolveOmoLaunch();
    const stored = input.persistence?.data;
    const sessionFile =
      typeof stored === "object" && stored !== null && typeof (stored as { sessionFile?: unknown }).sessionFile === "string"
        ? ((stored as { sessionFile: string }).sessionFile as string)
        : undefined;
    log(`opening session ${input.sessionId} via ${launch.origin}${sessionFile ? " (resume)" : ""}`);
    const session = new OmoSession({
      paseoSessionId: input.sessionId,
      launch,
      config: input.config,
      capabilities,
      ...(sessionFile ? { sessionFile } : {}),
      emit,
      log,
      onRuntimeFailure: (message) => {
        emit({ type: "session.runtime_failed", sessionId: input.sessionId, error: { message } });
      },
    });
    sessions.set(input.sessionId, session);
    try {
      await session.open(input.requestId, input.history);
    } catch (error) {
      sessions.delete(input.sessionId);
      session.close();
      throw error;
    }
  }

  function requireSession(sessionId: string): OmoSession {
    const session = sessions.get(sessionId);
    if (!session) throw new Error(`Unknown OmO session: ${sessionId}`);
    return session;
  }

  async function dispatch(input: ProviderInput): Promise<void> {
    switch (input.type) {
      case "catalog":
        try {
          await handleCatalog(input);
        } catch (error) {
          fail(input.requestId, error);
        }
        return;
      case "sessions":
        try {
          await handleSessions(input);
        } catch (error) {
          fail(input.requestId, error);
        }
        return;
      case "session.open":
        try {
          await handleOpen(input);
        } catch (error) {
          fail(input.requestId, error);
        }
        return;
      case "session.prompt": {
        const session = requireSession(input.sessionId);
        if (input.prompt.input.type === "command") {
          const args = input.prompt.input.arguments.trim();
          const text = `/${input.prompt.input.name}${args ? ` ${args}` : ""}`;
          session.prompt(input.prompt.clientMessageId, text, [], input.prompt.delivery === "steer");
          return;
        }
        const texts: string[] = [];
        const images: Array<{ data: string; mimeType: string }> = [];
        for (const part of input.prompt.input.content) {
          if (part.type === "text") {
            texts.push(part.text);
          } else if (part.type === "image") {
            images.push({ data: part.data, mimeType: part.mimeType });
          } else if (part.type === "uploaded_file") {
            texts.push(`Attached file: ${part.path}`);
          } else if ("text" in part && typeof part.text === "string") {
            texts.push(part.text);
          } else if ("body" in part && typeof part.body === "string") {
            texts.push(part.body);
          }
        }
        session.prompt(input.prompt.clientMessageId, texts.join("\n\n"), images, input.prompt.delivery === "steer");
        return;
      }
      case "session.interrupt":
        try {
          await requireSession(input.sessionId).interrupt();
          emit({ type: "request.completed", requestId: input.requestId });
        } catch (error) {
          fail(input.requestId, error);
        }
        return;
      case "session.configure":
        try {
          await requireSession(input.sessionId).configure(input.changes);
          emit({ type: "request.completed", requestId: input.requestId });
        } catch (error) {
          fail(input.requestId, error);
        }
        return;
      case "session.permission":
        requireSession(input.sessionId).respondToPermission(input.permissionId, input.response);
        return;
      case "session.close": {
        const session = sessions.get(input.sessionId);
        sessions.delete(input.sessionId);
        session?.close();
        emit({ type: "session.closed", sessionId: input.sessionId });
        emit({ type: "request.completed", requestId: input.requestId });
        return;
      }
      case "session.revert":
      case "session.archive":
      case "session.unarchive":
        emit({ type: "request.failed", requestId: input.requestId, error: { message: "Not supported by OmO" } });
        return;
      default:
        return;
    }
  }

  return {
    version: 1,
    capabilities,
    async send(input) {
      if (closed) throw new Error("OmO provider connection is closed");
      if (input.type !== "session.open" && "sessionId" in input && !sessions.has(input.sessionId)) {
        throw new Error(`Unknown OmO session: ${input.sessionId}`);
      }
      requireProviderCapabilities(capabilities, input);
      queueMicrotask(() => {
        if (closed) return;
        void dispatch(input).catch((error: unknown) => log(`dispatch failed: ${describe(error)}`));
      });
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      if (closed) return;
      closed = true;
      const open = [...sessions.values()];
      sessions.clear();
      for (const session of open) session.close();
      listeners.clear();
    },
  };
}
