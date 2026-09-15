import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { atomicWriteJson } from "./atomic-json.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test("retains and then replaces a snapshot when a reader briefly denies replacement", async () => {
  // Given a real old snapshot and one observed sharing violation at the rename seam.
  const directory = mkdtempSync(path.join(tmpdir(), "omo-atomic-"));
  const file = path.join(directory, "state.json");
  writeFileSync(file, JSON.stringify({ status: "pending" }));
  const rename = fs.rename;
  let observed: () => void = () => { throw new Error("Observer was not initialized"); };
  const denied = new Promise<void>(resolve => { observed = resolve; });
  vi.useFakeTimers();
  vi.spyOn(fs, "rename").mockImplementationOnce(async () => {
    observed();
    throw Object.assign(new Error("sharing violation"), { code: "EPERM" });
  }).mockImplementation(rename);
  try {
    // When a state publication encounters that transient reader.
    const publication = atomicWriteJson(file, { status: "running" });
    const outcome = publication.then(() => null, error => error);
    await denied;
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ status: "pending" });
    await vi.runAllTimersAsync();

    // Then publication succeeds without discarding the prior committed snapshot.
    expect(await outcome).toBeNull();
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ status: "running" });
    expect(readdirSync(directory)).toEqual(["state.json"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
