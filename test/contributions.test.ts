import { describe, expect, it } from "vitest";
import contribute from "../index.client.js";
import { duplicates, recordingClient } from "./recording.js";

/**
 * C1 - the merged plugin must expose the union of the four original plugins'
 * client surfaces, each registered exactly once. Before the merge, `omo` and
 * `omo-dag` both registered panel "dag", command "open-dag-panel" and surface
 * "dag-global", so the user saw two identical "OmO DAG" entries.
 */
describe("unified client contributions", () => {
  it("registers every surface exactly once", () => {
    const { ctx, rec } = recordingClient();
    contribute(ctx as never);

    expect({
      panels: duplicates(rec.panels),
      sidebar: duplicates(rec.sidebar),
      commands: duplicates(rec.commands),
      surfaces: duplicates(rec.surfaces),
      renderers: duplicates(rec.renderers),
      transformers: duplicates(rec.transformers),
      titles: duplicates(rec.titles),
    }).toEqual({
      panels: [],
      sidebar: [],
      commands: [],
      surfaces: [],
      renderers: [],
      transformers: [],
      titles: [],
    });
  });

  it("covers the union of the four original plugins' contributions", () => {
    const { ctx, rec } = recordingClient();
    contribute(ctx as never);

    // The worker surfaces are gone: the user asked for the OmO worker UI to be
    // removed, so the entry must not register its panel, its command, or its
    // per-agent pill any more. The approvals panel takes the agent-context slot
    // the workers panel used to hold, so a pending confirm/select/question can
    // be answered from inside the plugin.
    // The folder browser is its own workspace panel: DAG runs and the parallel
    // sessions under them are grouped into a tree the user can actually browse.
    expect([...rec.panels].sort()).toEqual(["approvals", "dag", "folders"]);
    expect(rec.sidebar).toEqual(["omo-dag"]);
    expect([...rec.commands].sort()).toEqual([
      "open-approvals-panel",
      "open-dag-explorer",
      "open-dag-panel",
      "open-folders-panel",
    ]);
    expect(rec.surfaces).toEqual(["dag-global"]);
    // The DAG run card, plus the live todo card that replaces the built-in
    // todo row and its transformer.
    expect([...rec.renderers].sort()).toEqual(["omo-dag-run@1", "omo-todo@1"]);
    expect(rec.transformers).toEqual(["omo-todo"]);
  });

  it("releases every registration it made when the entry is cleaned up", () => {
    const { ctx, rec } = recordingClient();
    const cleanup = contribute(ctx as never);

    expect(rec.registered.length).toBeGreaterThan(0);
    expect([...rec.outstanding].sort()).toEqual([...rec.registered].sort());

    cleanup();

    // Identity, not a count: a total would let one handle released twice hide
    // another that leaked.
    expect([...rec.outstanding]).toEqual([]);
  });

  it("a remover called twice cannot disguise a registration that was never released", () => {
    const { ctx, rec } = recordingClient();
    const first = ctx.addWorkspacePanel({ id: "probe-a", title: "A" } as never);
    ctx.addWorkspacePanel({ id: "probe-b", title: "B" } as never);

    first();
    first();

    expect(rec.released).toBe(1);
    expect([...rec.outstanding]).toEqual(["panel:probe-b"]);
  });
});
