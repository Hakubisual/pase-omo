import { afterEach, expect, it } from "vitest";

import {
  applyOmoUpdate,
  awaitOmoUpdateJob,
  omoUpdateJob,
  resetOmoUpdateJob,
  runOmoUpdateJob,
} from "./update.js";
import { OmoSessionRegistry, type LiveOmoSession } from "./session-registry.js";
import type { OmoUpdateJob } from "../../shared/update.js";

/**
 * Two things decide whether an update is safe.
 *
 * The ORDER: every OmO child has to be gone before the installer rewrites the
 * files it is running from, and every session that was stopped has to come back
 * even when the install itself failed - a session left suspended is a chat that
 * answers nothing.
 *
 * And the RETURN: the daemon kills a plugin RPC after 30 seconds, so the call
 * that starts this work cannot be the call that waits for it. Applying starts a
 * job and reports through `update.status`; waiting inside the handler is what
 * made a completed update surface as `Plugin RPC timed out`.
 */

afterEach(() => {
  resetOmoUpdateJob();
});

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

function newJob(install: boolean): OmoUpdateJob {
  return {
    phase: "suspending",
    install,
    total: 0,
    suspended: 0,
    resumed: 0,
    failures: [],
    installError: null,
    version: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
}

it("stops every session, installs, then resumes them", async () => {
  const log: string[] = [];
  const job = newJob(true);

  await runOmoUpdateJob({ install: true }, job, {
    registry: registryOf([fakeSession("a", log), fakeSession("b", log)]),
    runInstall: async () => {
      log.push("install");
    },
    readVersion: async () => "5.0.0-0.beta.63",
  });

  expect(log).toEqual(["suspend:a", "suspend:b", "install", "resume:a", "resume:b"]);
  expect(job.phase).toBe("done");
  expect(job).toMatchObject({
    total: 2,
    suspended: 2,
    resumed: 2,
    failures: [],
    installError: null,
    version: "5.0.0-0.beta.63",
  });
  expect(job.finishedAt).not.toBeNull();
});

it("resumes the sessions it stopped even when the install fails", async () => {
  const log: string[] = [];
  const job = newJob(true);

  await runOmoUpdateJob({ install: true }, job, {
    registry: registryOf([fakeSession("a", log)]),
    runInstall: async () => {
      throw new Error("bun add failed");
    },
    readVersion: async () => "5.0.0-0.beta.62",
  });

  expect(log).toEqual(["suspend:a", "resume:a"]);
  expect(job.installError).toBe("bun add failed");
  expect(job.resumed).toBe(1);
  expect(job.phase).toBe("failed");
});

it("skips the install when only a restart was asked for", async () => {
  const log: string[] = [];
  const job = newJob(false);

  await runOmoUpdateJob({ install: false }, job, {
    registry: registryOf([fakeSession("a", log)]),
    runInstall: async () => {
      log.push("install");
    },
    readVersion: async () => null,
  });

  expect(log).toEqual(["suspend:a", "resume:a"]);
  expect(job.phase).toBe("done");
});

it("reports a session that could not be stopped and does not resume it", async () => {
  const log: string[] = [];
  const job = newJob(false);

  await runOmoUpdateJob({ install: false }, job, {
    registry: registryOf([fakeSession("a", log, "suspend"), fakeSession("b", log)]),
    runInstall: async () => {},
    readVersion: async () => null,
  });

  expect(log).toEqual(["suspend:b", "resume:b"]);
  expect(job.resumed).toBe(1);
  expect(job.failures).toEqual(["a: 정지 실패 — stuck"]);
  expect(job.phase).toBe("failed");
});

it("reports a session that never came back", async () => {
  const log: string[] = [];
  const job = newJob(false);

  await runOmoUpdateJob({ install: false }, job, {
    registry: registryOf([fakeSession("a", log, "resume")]),
    runInstall: async () => {},
    readVersion: async () => null,
  });

  expect(job.resumed).toBe(0);
  expect(job.failures).toEqual(["a: 재개 실패 — no runtime"]);
});

it("returns while the install is still running instead of waiting for it", async () => {
  const log: string[] = [];
  let releaseInstall: (() => void) | undefined;
  const install = new Promise<void>((resolve) => {
    releaseInstall = resolve;
  });

  const started = await applyOmoUpdate({ install: true }, null, {
    registry: registryOf([fakeSession("a", log)]),
    runInstall: async () => {
      log.push("install-start");
      await install;
      log.push("install-end");
    },
    readVersion: async () => "5.0.0-0.beta.63",
  });

  // The handler answered while the installer is still holding its promise.
  expect(started).toMatchObject({ started: true, alreadyRunning: false });
  expect(started.job.phase).toBe("suspending");
  expect(log).not.toContain("install-end");

  // A second press while the first run is live starts nothing new.
  const second = await applyOmoUpdate({ install: true }, null, {
    registry: registryOf([fakeSession("b", log)]),
    runInstall: async () => {
      log.push("second-install");
    },
  });
  expect(second).toMatchObject({ started: false, alreadyRunning: true });

  releaseInstall?.();
  await awaitOmoUpdateJob();

  expect(log).toEqual(["suspend:a", "install-start", "install-end", "resume:a"]);
  expect(omoUpdateJob()).toMatchObject({ phase: "done", resumed: 1, version: "5.0.0-0.beta.63" });
});

it("keeps a defect inside the job instead of leaving the button spinning", async () => {
  const registry = new OmoSessionRegistry();
  registry.add({
    sessionId: "boom",
    durableSessionFile: undefined,
    getPendingUiRequests: () => [],
    respondToUiRequest: () => {},
    suspend: (() => {
      throw new Error("not even a promise");
    }) as unknown as LiveOmoSession["suspend"],
    resume: async () => {},
  });

  await applyOmoUpdate({ install: false }, null, { registry, readVersion: async () => null });
  await awaitOmoUpdateJob();

  const job = omoUpdateJob();
  expect(job?.phase).toBe("failed");
  expect(job?.failures.join(" ")).toContain("not even a promise");
});
