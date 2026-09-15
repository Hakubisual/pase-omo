import { expect, it } from "vitest";

import { applyOmoUpdate } from "./update.js";
import { OmoSessionRegistry, type LiveOmoSession } from "./session-registry.js";

/**
 * The point of the update action is the ORDER: every OmO child has to be gone
 * before the installer rewrites the files it is running from, and every session
 * that was stopped has to come back even when the install itself failed. A
 * session left suspended is a chat that answers nothing, which is worse than a
 * skipped update.
 */

function fakeSession(id: string, log: string[], failOn?: "suspend" | "resume"): LiveOmoSession {
  return {
    sessionId: id,
    durableSessionFile: `${id}.jsonl`,
    getPendingUiRequests: () => [],
    respondToUiRequest: () => {},
    async suspend() {
      if (failOn === "suspend") throw new Error("stuck");
      log.push(`suspend:${id}`);
    },
    async resume() {
      if (failOn === "resume") throw new Error("no runtime");
      log.push(`resume:${id}`);
    },
  };
}

function registryOf(sessions: readonly LiveOmoSession[]): OmoSessionRegistry {
  const registry = new OmoSessionRegistry();
  for (const session of sessions) registry.add(session);
  return registry;
}

it("stops every session, installs, then resumes them", async () => {
  const log: string[] = [];
  const registry = registryOf([fakeSession("a", log), fakeSession("b", log)]);

  const result = await applyOmoUpdate({ install: true }, null, {
    registry,
    runInstall: async () => {
      log.push("install");
    },
    readVersion: async () => "5.0.0-0.beta.63",
  });

  expect(log).toEqual(["suspend:a", "suspend:b", "install", "resume:a", "resume:b"]);
  expect(result).toEqual({
    installed: true,
    version: "5.0.0-0.beta.63",
    resumed: 2,
    failures: [],
    installError: null,
  });
});

it("resumes the sessions it stopped even when the install fails", async () => {
  const log: string[] = [];
  const registry = registryOf([fakeSession("a", log)]);

  const result = await applyOmoUpdate({ install: true }, null, {
    registry,
    runInstall: async () => {
      throw new Error("bun add failed");
    },
    readVersion: async () => "5.0.0-0.beta.62",
  });

  expect(log).toEqual(["suspend:a", "resume:a"]);
  expect(result.installed).toBe(false);
  expect(result.installError).toBe("bun add failed");
  expect(result.resumed).toBe(1);
});

it("skips the install when only a restart was asked for", async () => {
  const log: string[] = [];
  const registry = registryOf([fakeSession("a", log)]);

  const result = await applyOmoUpdate({ install: false }, null, {
    registry,
    runInstall: async () => {
      log.push("install");
    },
    readVersion: async () => null,
  });

  expect(log).toEqual(["suspend:a", "resume:a"]);
  expect(result.installed).toBe(false);
});

it("reports a session that could not be stopped and does not resume it", async () => {
  const log: string[] = [];
  const registry = registryOf([fakeSession("a", log, "suspend"), fakeSession("b", log)]);

  const result = await applyOmoUpdate({ install: false }, null, {
    registry,
    runInstall: async () => {},
    readVersion: async () => null,
  });

  expect(log).toEqual(["suspend:b", "resume:b"]);
  expect(result.resumed).toBe(1);
  expect(result.failures).toEqual(["a: 정지 실패 — stuck"]);
});

it("reports a session that never came back", async () => {
  const log: string[] = [];
  const registry = registryOf([fakeSession("a", log, "resume")]);

  const result = await applyOmoUpdate({ install: false }, null, {
    registry,
    runInstall: async () => {},
    readVersion: async () => null,
  });

  expect(result.resumed).toBe(0);
  expect(result.failures).toEqual(["a: 재개 실패 — no runtime"]);
});
