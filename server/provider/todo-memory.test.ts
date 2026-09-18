import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { lastPublishedTodo, rememberPublishedTodo } from "./todo-memory.js";

/**
 * Paseo's timeline cannot take a row back, so the only way to avoid a second
 * identical todo card is to remember the first one somewhere that survives the
 * session object - a reopened agent and a reloaded plugin both build a new one.
 */

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function env(): Promise<NodeJS.ProcessEnv> {
  const root = await mkdtemp(join(tmpdir(), "omo-todo-memory-"));
  roots.push(root);
  return { OMO_CODING_AGENT_DIR: join(root, "agent") };
}

it("remembers the card a session drew", async () => {
  const scope = await env();
  expect(await lastPublishedTodo("session-a.jsonl", scope)).toBeUndefined();

  await rememberPublishedTodo("session-a.jsonl", "sig-1", scope);

  expect(await lastPublishedTodo("session-a.jsonl", scope)).toBe("sig-1");
});

it("keeps one entry per session", async () => {
  const scope = await env();
  await rememberPublishedTodo("session-a.jsonl", "sig-a", scope);
  await rememberPublishedTodo("session-b.jsonl", "sig-b", scope);

  expect(await lastPublishedTodo("session-a.jsonl", scope)).toBe("sig-a");
  expect(await lastPublishedTodo("session-b.jsonl", scope)).toBe("sig-b");
});

it("replaces the note when the list moves on", async () => {
  const scope = await env();
  await rememberPublishedTodo("session-a.jsonl", "sig-1", scope);
  await rememberPublishedTodo("session-a.jsonl", "sig-2", scope);

  expect(await lastPublishedTodo("session-a.jsonl", scope)).toBe("sig-2");
});

it("treats an unreadable store as nothing drawn yet", async () => {
  const scope = await env();
  const file = join(scope.OMO_CODING_AGENT_DIR as string, "paseo-todo-cards.json");
  await mkdir(join(scope.OMO_CODING_AGENT_DIR as string), { recursive: true });
  await writeFile(file, "{ this is not json");

  // Worst case is one duplicate card, which is what a throw here would trade
  // for a session that publishes nothing at all.
  expect(await lastPublishedTodo("session-a.jsonl", scope)).toBeUndefined();
  await rememberPublishedTodo("session-a.jsonl", "sig-1", scope);
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ "session-a.jsonl": "sig-1" });
});
