import type { PluginHandlerContext } from "@getpaseo/plugin/server";

import type { OmoSession } from "./omo-session.js";

/**
 * What the RPC surfaces need from a live session.
 *
 * Structural rather than the class itself so tests can register fakes: the
 * approval handlers answer one agent's pending request, and the update handler
 * suspends and resumes every session at once.
 */
export type LiveOmoSession = Pick<
  OmoSession,
  | "durableSessionFile"
  | "getPendingUiRequests"
  | "respondToUiRequest"
  | "sessionId"
  | "suspend"
  | "resume"
>;

function normalizedFile(value: string): string {
  return value.replace(/\\/g, "/").toLowerCase();
}

function sessionFileFromRuntime(runtimeSessionId: string): string | undefined {
  const objectStart = runtimeSessionId.indexOf("{");
  if (objectStart < 0) return undefined;
  try {
    const parsed = JSON.parse(runtimeSessionId.slice(objectStart)) as {
      data?: { sessionFile?: unknown };
    };
    return typeof parsed.data?.sessionFile === "string" ? parsed.data.sessionFile : undefined;
  } catch {
    return undefined;
  }
}

/** Live OmO sessions are registered by OmoSession construction and removed on close. */
export class OmoSessionRegistry {
  private readonly sessions = new Set<LiveOmoSession>();

  add(session: LiveOmoSession): () => void {
    this.sessions.add(session);
    return () => {
      this.sessions.delete(session);
    };
  }

  /** Every session this daemon currently holds open, in registration order. */
  list(): LiveOmoSession[] {
    return [...this.sessions];
  }

  private matchingSession(agentId: string, runtimeSessionId?: string): LiveOmoSession | undefined {
    for (const session of this.sessions) {
      if (session.sessionId === agentId || session.sessionId === runtimeSessionId) return session;
    }

    if (!runtimeSessionId) return undefined;
    const runtimeFile = sessionFileFromRuntime(runtimeSessionId);
    if (!runtimeFile) return undefined;
    const expected = normalizedFile(runtimeFile);
    return [...this.sessions].find(
      (session) => session.durableSessionFile !== undefined && normalizedFile(session.durableSessionFile) === expected,
    );
  }

  async forAgent(agentId: string, context: PluginHandlerContext): Promise<LiveOmoSession> {
    const direct = this.matchingSession(agentId);
    if (direct) return direct;

    const handle = context.paseo.agents.ref(agentId);
    let agent = handle.current();
    if (!agent?.runtimeInfo?.sessionId) agent = (await handle.refresh())?.agent ?? agent;
    const runtimeSessionId = agent?.runtimeInfo?.sessionId ?? undefined;
    const session = this.matchingSession(agentId, runtimeSessionId);
    if (!session) throw new Error(`No live OmO session for agent: ${agentId}`);
    return session;
  }
}

export const omoSessionRegistry = new OmoSessionRegistry();
