import type { PluginTheme } from "@getpaseo/plugin";
import { describe, expect, it } from "vitest";

import { TODO_STATUSES } from "../shared/todo";
import { entryVisual } from "./todo-visual";

const theme = {
  colors: {
    surface0: "#101014",
    surface1: "#17171d",
    surface2: "#1f1f27",
    foreground: "#e7e7ef",
    foregroundMuted: "#9a9aa8",
    border: "#2c2c36",
    accent: "#7aa2f7",
    accentForeground: "#0b0b10",
    statusSuccess: "#54c98a",
    statusDanger: "#f2637e",
    statusWarning: "#e6b455",
  },
} as unknown as PluginTheme;

describe("entryVisual", () => {
  it("checks a finished task off and strikes it through", () => {
    const done = entryVisual("completed", theme);

    expect(done.marker).toBe("[✓]");
    expect(done.markerColor).toBe(theme.colors.statusSuccess);
    expect(done.struck).toBe(true);
    expect(done.textColor).toBe(theme.colors.foregroundMuted);
    expect(done.lit).toBe(false);
  });

  it("lights the task being worked on right now", () => {
    const busy = entryVisual("in_progress", theme);

    expect(busy.marker).toBe("[•]");
    expect(busy.markerColor).toBe(theme.colors.accent);
    expect(busy.lit).toBe(true);
    expect(busy.struck).toBe(false);
    // The live row is the one the eye should land on first.
    expect(busy.textColor).toBe(theme.colors.foreground);
    expect(busy.backgroundColor).not.toBe(entryVisual("pending", theme).backgroundColor);
  });

  it("leaves a queued task quiet", () => {
    const waiting = entryVisual("pending", theme);

    expect(waiting.marker).toBe("[ ]");
    expect(waiting.markerColor).toBe(theme.colors.foregroundMuted);
    expect(waiting.struck).toBe(false);
    expect(waiting.lit).toBe(false);
  });

  it("gives every status a distinct marker so the list is readable without colour", () => {
    // Colour alone fails for a colour-blind reader and in a high-contrast theme.
    const markers = TODO_STATUSES.map((status) => entryVisual(status, theme).marker);

    expect(new Set(markers).size).toBe(TODO_STATUSES.length);
    expect(markers.every((marker) => marker.length > 0)).toBe(true);
  });

  it("describes each row for a screen reader", () => {
    expect(entryVisual("completed", theme).spoken).toBe("Done");
    expect(entryVisual("in_progress", theme).spoken).toBe("In progress");
    expect(entryVisual("pending", theme).spoken).toBe("Pending");
  });
});
