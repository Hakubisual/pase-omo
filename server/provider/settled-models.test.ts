import { describe, expect, test } from "vitest";

import { settledModels } from "./omo-session.js";

const model = (provider: string, id: string) => ({ provider, id });
const id = (entry: { provider: string; id: string }) => `${entry.provider}/${entry.id}`;

describe("settledModels", () => {
  test("stops once the list has held still for the whole quiet window", async () => {
    let calls = 0;
    const models = await settledModels(
      async () => {
        calls += 1;
        return [model("cliproxyapi", "gpt-6-luna")];
      },
      { intervalMs: 0, stablePolls: 2 },
    );
    expect(models.map(id)).toEqual(["cliproxyapi/gpt-6-luna"]);
    // Two quiet replies after the first: one answer is never taken as settled.
    expect(calls).toBe(3);
  });

  test("catches a late registration that follows an equally sized reply", async () => {
    // The CPA-style extension registers a moment after the channel answers. The
    // first two replies are the same size, so a wait that stopped on the first
    // unchanged size would return before the third and leave the picker short.
    const early = [model("cliproxyapi-last", "higher-coding")];
    const settled = [...early, model("cliproxyapi", "gpt-6-luna")];
    const answers = [early, early, settled, settled, settled, settled];
    let calls = 0;
    const models = await settledModels(async () => answers[Math.min(calls++, answers.length - 1)] ?? [], {
      intervalMs: 0,
    });
    expect(models.map(id)).toEqual(["cliproxyapi-last/higher-coding", "cliproxyapi/gpt-6-luna"]);
    expect(calls).toBe(6);
  });

  test("never shrinks the answer when a reply drops a provider", async () => {
    // OmO can answer a provider list that omits one already seen. A short reply
    // is not a settled catalog, and must not be published in place of the full
    // list the picker was already built from.
    const full = [model("cliproxyapi", "gpt-6-luna"), model("baseten", "deepseek-v4-flash")];
    const partial = [model("cliproxyapi", "gpt-6-luna")];
    const answers = [full, partial, full, full, full];
    let calls = 0;
    const models = await settledModels(async () => answers[Math.min(calls++, answers.length - 1)] ?? [], {
      intervalMs: 0,
      stablePolls: 2,
    });
    expect(models.map(id)).toEqual(["cliproxyapi/gpt-6-luna", "baseten/deepseek-v4-flash"]);
  });

  test("is bounded so a never-settling list still answers", async () => {
    let calls = 0;
    const models = await settledModels(
      async () => {
        calls += 1;
        return [model("cliproxyapi", `grow-${calls}`)];
      },
      { intervalMs: 0, maxAttempts: 3 },
    );
    expect(calls).toBe(3);
    expect(models).toHaveLength(3);
  });
});
