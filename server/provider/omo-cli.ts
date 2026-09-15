import { accessSync, constants, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

import { agentDir } from "./omo-store.js";

/** How the OmO CLI is launched, resolved once per daemon process. */
export interface OmoLaunch {
  /** argv[0] plus any fixed leading arguments (for example a Bun runtime path). */
  command: string;
  base: string[];
  /** Human-readable description of how this was resolved, for logs and notices. */
  origin: string;
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return existsSync(path);
  }
}

/** Windows resolves bare names through PATHEXT; POSIX uses the name verbatim. */
function candidateNames(): string[] {
  if (process.platform !== "win32") return ["omo"];
  const exts = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  // Extensionless shims exist on Windows too, so the bare name stays a candidate.
  return [...exts.map((ext) => `omo${ext.toLowerCase()}`), "omo"];
}

function fromPath(): string | undefined {
  const entries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const entry of entries) {
    for (const name of candidateNames()) {
      const candidate = join(entry, name);
      if (executable(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * Where package managers park a global `omo-ai`.
 *
 * The daemon does not necessarily inherit a login shell's PATH — one launched
 * from a desktop session often gets a minimal one — so an install that is
 * perfectly reachable in a terminal can be invisible to a PATH search. Probing
 * these layouts by absolute path is what makes resolution survive that, and
 * covering more than Bun is what makes a non-Bun install resolve at all.
 */
function globalPackageRoots(): string[] {
  const home = homedir();
  const roots: string[] = [join(home, ".bun", "install", "global", "node_modules")];
  const add = (...parts: Array<string | undefined>): void => {
    if (parts.every((part) => typeof part === "string" && part.length > 0)) {
      roots.push(join(...(parts as string[])));
    }
  };
  add(process.env.PNPM_HOME, "global", "5", "node_modules");
  if (process.platform === "win32") {
    add(process.env.npm_config_prefix, "node_modules");
    add(process.env.APPDATA, "npm", "node_modules");
    add(home, "AppData", "Roaming", "npm", "node_modules");
  } else {
    add(process.env.npm_config_prefix, "lib", "node_modules");
    roots.push("/usr/local/lib/node_modules", "/usr/lib/node_modules", "/opt/homebrew/lib/node_modules");
    add(home, ".npm-global", "lib", "node_modules");
    add(home, ".local", "share", "pnpm", "global", "5", "node_modules");
    add(home, ".config", "yarn", "global", "node_modules");
  }
  add(home, ".yarn", "global", "node_modules");
  return [...new Set(roots)];
}

/** A runtime able to execute omo's `.js` entry point. */
function javascriptRuntime(): string | undefined {
  const bun = join(homedir(), ".bun", "bin", process.platform === "win32" ? "bun.exe" : "bun");
  if (executable(bun)) return bun;
  return fromPathNamed("bun") ?? fromPathNamed("node");
}

/** A global `omo-ai` package plus a runtime to launch its entry point. */
function fromGlobalInstall(searched: string[]): OmoLaunch | undefined {
  for (const root of globalPackageRoots()) {
    const entry = join(root, "omo-ai", "bin", "omo.js");
    searched.push(entry);
    if (!existsSync(entry)) continue;
    const runtime = javascriptRuntime();
    if (runtime) return { command: runtime, base: [entry], origin: `global install at ${root}` };
  }
  return undefined;
}

function fromPathNamed(name: string): string | undefined {
  const entries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const names =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .filter(Boolean)
          .map((ext) => `${name}${ext.toLowerCase()}`)
      : [name];
  for (const entry of entries) {
    for (const candidate of names) {
      const full = join(entry, candidate);
      if (executable(full)) return full;
    }
  }
  return undefined;
}

/**
 * Identity of OmO's model configuration.
 *
 * The registered model catalog is whatever omo's own config files say it is, so
 * a catalog is only valid for one state of those files. This fingerprint is
 * derived from their path, size and mtime, and callers compare it to decide
 * whether a cached catalog still describes the configuration on disk.
 *
 * Both directories are covered because OmO splits its configuration across
 * them: `models.json` and `settings.json` live in the agent directory, while
 * `omo.jsonc` sits in the user config directory above it. Watching only the
 * agent directory would report omo.jsonc as missing and let an edit there go
 * unnoticed.
 *
 * Deliberately the whole model configuration rather than only models.json:
 * omo.jsonc and settings.json also decide which models exist and which provider
 * they resolve through, so a category or provider edit has to move the
 * fingerprint too. It is read cheaply (no file bodies) because the catalog path
 * is hot: Paseo asks for a key on every provider snapshot.
 *
 * A missing or unreadable file is encoded rather than thrown, so an unreadable
 * config perturbs the key (forcing a re-probe) instead of failing the request,
 * and a file that first appears still changes the key. The string is compared
 * for equality only, never parsed.
 */
export async function modelConfigFingerprint(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const agent = agentDir(env);
  const user = join(agent, "..");
  const targets: Array<[string, string]> = [
    [agent, "models.json"],
    [agent, "models-store.json"],
    [agent, "settings.json"],
    [user, "omo.jsonc"],
    [user, "omo.json"],
    [user, "config.jsonc"],
  ];
  const parts = await Promise.all(
    targets.map(async ([directory, name]) => {
      try {
        const info = await stat(join(directory, name));
        return `${name}:${info.size}:${info.mtimeMs}`;
      } catch (error) {
        return `${name}:${(error as { code?: string }).code ?? "error"}`;
      }
    }),
  );
  return parts.join("|");
}

/**
 * Resolve the OmO CLI.
 *
 * `PASEO_OMO_COMMAND` wins and is a JSON array, for example
 * `["C:/Users/me/.bun/bin/bun.exe","C:/.../omo-ai/bin/omo.js"]`.
 * `PASEO_OMO_BINARY` names a single executable. Otherwise PATH is searched for
 * an `omo` launcher, then Bun's global `omo-ai` entry point.
 */
export function resolveOmoLaunch(env: NodeJS.ProcessEnv = process.env): OmoLaunch {
  const explicit = env.PASEO_OMO_COMMAND?.trim();
  if (explicit) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(explicit);
    } catch {
      throw new Error("PASEO_OMO_COMMAND must be a JSON array of strings");
    }
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((v) => typeof v !== "string")) {
      throw new Error("PASEO_OMO_COMMAND must be a JSON array of strings");
    }
    const [command, ...base] = parsed as [string, ...string[]];
    return { command, base, origin: "PASEO_OMO_COMMAND" };
  }

  const binary = env.PASEO_OMO_BINARY?.trim() || env.OMO_BINARY?.trim() || env.CHAT_PI_BINARY?.trim();
  if (binary) {
    if (binary.endsWith(".js") || binary.endsWith(".mjs")) {
      const runtime = fromPathNamed("bun") ?? fromPathNamed("node");
      if (!runtime) throw new Error(`No JavaScript runtime on PATH to run ${binary}`);
      return { command: runtime, base: [binary], origin: "PASEO_OMO_BINARY (script)" };
    }
    return { command: binary, base: [], origin: "PASEO_OMO_BINARY" };
  }

  const onPath = fromPath();
  if (onPath) return { command: onPath, base: [], origin: "PATH" };

  // Report what was looked at: "not found" while omo is demonstrably installed
  // is otherwise impossible to act on, and the usual cause is a daemon PATH that
  // does not match the terminal's.
  const searched: string[] = [];
  const globalInstall = fromGlobalInstall(searched);
  if (globalInstall) return globalInstall;

  throw new Error(
    [
      "OmO CLI not found. Install it with `bun add -g omo-ai@beta`, or set PASEO_OMO_COMMAND",
      "to a JSON argv array if it lives somewhere else.",
      `Searched PATH (${(process.env.PATH ?? "").split(delimiter).filter(Boolean).length} entries) and:`,
      ...searched.map((entry) => `  ${entry}`),
    ].join("\n"),
  );
}
