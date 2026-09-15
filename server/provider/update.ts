import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { PluginCleanup } from "@getpaseo/plugin";
import type { PluginServerContext } from "@getpaseo/plugin/server";

import {
  applyOmoUpdateRpc,
  omoUpdateStatusRpc,
  OMO_CHANNEL,
  OMO_PACKAGE,
  type ApplyOmoUpdateInput,
  type ApplyOmoUpdatePayload,
  type OmoUpdateStatusPayload,
} from "../../shared/update.js";
import { fromPathNamed, resolveOmoLaunch } from "./omo-cli.js";
import { omoSessionRegistry, type OmoSessionRegistry } from "./session-registry.js";

const REGISTRY_URL = `https://registry.npmjs.org/${OMO_PACKAGE}`;
const REGISTRY_TIMEOUT_MS = 10_000;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Where the launched CLI's own package manifest lives.
 *
 * The launch is `<runtime> <entry>` for a script install and a bare executable
 * otherwise, so the search starts at the entry when there is one and walks up
 * until a manifest names the package. A launcher shim on PATH has no manifest
 * above it, which is why the Bun global install is tried as well.
 */
function manifestCandidates(): string[] {
  const candidates: string[] = [];
  try {
    const launch = resolveOmoLaunch();
    let directory = dirname(launch.base[0] ?? launch.command);
    for (let depth = 0; depth < 5; depth += 1) {
      candidates.push(join(directory, "package.json"));
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  } catch {
    // An unresolvable CLI is reported by the caller through the version being null.
  }
  candidates.push(join(homedir(), ".bun", "install", "global", "node_modules", OMO_PACKAGE, "package.json"));
  return candidates;
}

/** Version of the OmO the daemon would launch, or null when no manifest names it. */
export async function installedOmoVersion(): Promise<string | null> {
  for (const candidate of manifestCandidates()) {
    try {
      const manifest = JSON.parse(await readFile(candidate, "utf8")) as { name?: unknown; version?: unknown };
      if (manifest.name !== OMO_PACKAGE || typeof manifest.version !== "string") continue;
      return manifest.version;
    } catch {
      continue;
    }
  }
  return null;
}

/** Newest version on OmO's release channel. Throws when the registry is unreachable. */
export async function availableOmoVersion(): Promise<string> {
  const response = await fetch(REGISTRY_URL, {
    headers: { accept: "application/vnd.npm.install-v1+json" },
    signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`npm registry answered ${response.status}`);
  const payload = (await response.json()) as { "dist-tags"?: Record<string, unknown> };
  const version = payload["dist-tags"]?.[OMO_CHANNEL];
  if (typeof version !== "string") throw new Error(`npm registry has no ${OMO_CHANNEL} tag for ${OMO_PACKAGE}`);
  return version;
}

/**
 * The global install command for this machine.
 *
 * Bun is preferred because that is how OmO installs itself here (its own
 * not-found message says `bun add -g omo-ai@beta`); npm is the fallback for a
 * machine without Bun.
 */
export function installCommand(): { command: string; args: string[] } {
  const bunHome = join(homedir(), ".bun", "bin", process.platform === "win32" ? "bun.exe" : "bun");
  const bun = existsSync(bunHome) ? bunHome : fromPathNamed("bun");
  if (bun) return { command: bun, args: ["add", "-g", `${OMO_PACKAGE}@${OMO_CHANNEL}`] };
  const npm = fromPathNamed("npm");
  if (npm) return { command: npm, args: ["install", "-g", `${OMO_PACKAGE}@${OMO_CHANNEL}`] };
  throw new Error("No bun or npm on PATH to install OmO with");
}

export function installCommandLine(): string {
  try {
    const { command, args } = installCommand();
    return [command, ...args].join(" ");
  } catch (error) {
    return describe(error);
  }
}

/** Runs the install, rejecting with the child's own output when it fails. */
async function runInstall(): Promise<void> {
  const { command, args } = installCommand();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const collect = (chunk: Buffer): void => {
      output = (output + chunk.toString("utf8")).slice(-4096);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => child.kill(), INSTALL_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`${command} failed to start: ${error.message}`));
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${[command, ...args].join(" ")} exited with code ${code ?? "null"}: ${output.trim()}`));
    });
  });
}

export async function omoUpdateStatus(
  _input: Record<string, never>,
  _context: unknown,
  registry: OmoSessionRegistry = omoSessionRegistry,
): Promise<OmoUpdateStatusPayload> {
  const installedVersion = await installedOmoVersion();
  let availableVersion: string | null = null;
  let error: string | null = null;
  try {
    availableVersion = await availableOmoVersion();
  } catch (failure) {
    error = describe(failure);
  }
  return {
    installedVersion,
    availableVersion,
    updateAvailable:
      installedVersion !== null && availableVersion !== null && installedVersion !== availableVersion,
    liveSessions: registry.list().length,
    installCommand: installCommandLine(),
    error,
  };
}

/**
 * Stop every OmO session, optionally replace the CLI, then bring the sessions
 * back on the same session files.
 *
 * The order is what makes an update safe: a child still running would keep the
 * old code loaded and race the installer over the files it replaces. Resume runs
 * for every suspended session even when the install failed, so a failed update
 * never leaves a session without a process.
 */
export interface ApplyOmoUpdateDeps {
  registry?: OmoSessionRegistry;
  /** Replaces the installed CLI. Injected so the order around it can be tested. */
  runInstall?: () => Promise<void>;
  readVersion?: () => Promise<string | null>;
}

export async function applyOmoUpdate(
  input: ApplyOmoUpdateInput,
  _context: unknown,
  deps: ApplyOmoUpdateDeps = {},
): Promise<ApplyOmoUpdatePayload> {
  const registry = deps.registry ?? omoSessionRegistry;
  const install = deps.runInstall ?? runInstall;
  const readVersion = deps.readVersion ?? installedOmoVersion;
  const sessions = registry.list();
  const failures: string[] = [];

  const suspended = [];
  for (const session of sessions) {
    try {
      await session.suspend();
      suspended.push(session);
    } catch (error) {
      failures.push(`${session.sessionId}: 정지 실패 — ${describe(error)}`);
    }
  }

  let installError: string | null = null;
  if (input.install) {
    try {
      await install();
    } catch (error) {
      installError = describe(error);
    }
  }

  let resumed = 0;
  for (const session of suspended) {
    try {
      await session.resume();
      resumed += 1;
    } catch (error) {
      failures.push(`${session.sessionId}: 재개 실패 — ${describe(error)}`);
    }
  }

  return {
    installed: input.install && installError === null,
    version: await readVersion(),
    resumed,
    failures,
    installError,
  };
}

/** Entry-point wiring: registers both update RPC contracts. */
export function registerUpdateHandlers(plugin: Pick<PluginServerContext, "handle">): PluginCleanup {
  plugin.handle(omoUpdateStatusRpc, omoUpdateStatus);
  plugin.handle(applyOmoUpdateRpc, applyOmoUpdate);
  return () => {};
}
