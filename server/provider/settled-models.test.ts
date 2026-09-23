import { describe, expect, test } from "vitest";

import { settledModels } from "./omo-session.js";

const model = (provider: string, id: string) => ({ provider, id });

describe("settledModels", () => {
  test("waits for asynchronously registered extension providers", async () => {
    // First answer is models.json only; the CPA extension registers the rest right after.
    const answers = [
      [model("cliproxyapi-last", "higher-coding")],
      [model("cliproxyapi-last", "higher-coding"), model("cliproxyapi", "gpt-6-luna")],
      [model("cliproxyapi-last", "higher-coding"), model("cliproxyapi", "gpt-6-luna")],
    ];
    let calls = 0;
    const models = await settledModels(async () => answers[Math.min(calls++, answers.length - 1)] ?? [], {
      intervalMs: 0,
    });
    expect(models.map((entry) => `${entry.provider}/${entry.id}`)).toEqual([
      "cliproxyapi-last/higher-coding",
      "cliproxyapi/gpt-6-luna",
    ]);
    expect(calls).toBe(3);
  });

  test("returns after one confirming answer when the list is already complete", async () => {
    let calls = 0;
    const models = await settledModels(async () => {
      calls += 1;
      return [model("cliproxyapi", "gpt-6-luna")];
    }, { intervalMs: 0 });
    expect(models).toHaveLength(1);
    expect(calls).toBe(2);
  });
});
