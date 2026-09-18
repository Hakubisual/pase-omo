import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { atomicWriteJson } from "../workers/atomic-json.js";
import { agentDir } from "./omo-store.js";

/**
 * The last todo list this plugin drew for a Paseo session.
 *
 * The card is published once per turn and only when the list reads differently
 * from the one already in the chat, but that comparison used to live in the
 * `OmoSession` object. Reopening the agent, reloading the plugin or restarting
 * a session for an update builds a new object with an empty memory, so the
 * first `todo` call afterwards - typically the agent re-reading its own list -
 * drew a second identical card. Paseo's timeline is append-only for these rows,
 * so a duplicate can never be taken back; it has to not be published.
 *
 * Stored on disk rather than in a module map because the plugin runs in a
 * daemon subprocess that is replaced on every reload, which is one of the
 * moments the duplicate appeared.
 */

function storeFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(agentDir(env), "paseo-todo-cards.json");
}

type Store = Record<string, string>;

async function readStore(file: string): Promise<Store> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return {};
    const store: Store = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string") store[key] = value;
    }
    return store;
  } catch {
    // A missing or unreadable file means "nothing drawn yet", which only risks
    // one duplicate card - never a lost one.
    return {};
  }
}

/** Signature of the card already in this session's chat, when one is recorded. */
export async function lastPublishedTodo(
  sessionKey: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const store = await readStore(storeFile(env));
  return store[sessionKey];
}

/**
 * Records the card just drawn.
 *
 * Reads before writing so two sessions publishing at once keep each other's
 * entries; the write itself is atomic.
 */
export async function rememberPublishedTodo(
  sessionKey: string,
  signature: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const file = storeFile(env);
  const store = await readStore(file);
  if (store[sessionKey] === signature) return;
  store[sessionKey] = signature;
  await atomicWriteJson(file, store);
}
