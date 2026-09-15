import type { PluginTheme } from "@getpaseo/plugin";
import { describe, expect, it } from "vitest";

import { toTodoRow, type TodoRow, type TodoStatus } from "../shared/todo";
import { createStyles, todoCardModel } from "./todo-visual";

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

/** Builds a real row through the shared transformer so the tests dogfood it. */
function row(items: unknown[], phase: "streaming" | "complete" = "streaming"): TodoRow {
  const built = toTodoRow(items, phase);
  if (built === null) throw new Error("test row builder produced no row");
  return built;
}

describe("todoCardModel", () => {
  it("recomputes the header counts from the entries it renders instead of trusting the payload", () => {
    const good = row([
      { text: "read the spec", completed: true, status: "completed", id: "a" },
      { text: "write the test", completed: false, status: "in_progress", id: "b", activeForm: "writing the test" },
      { text: "ship it", completed: false, status: "pending", id: "c" },
    ]);
    // A row can reach the renderer through a path that did not recompute its
    // counts (the daemon republishes the latest payload it kept); the header
    // must still agree with the list actually on screen.
    const stale: TodoRow = { ...good, total: 99, completed: 99 };

    const model = todoCardModel(stale, theme);

    expect(model.total).toBe(3);
    expect(model.completed).toBe(1);
    expect(model.remaining).toBe(2);
    expect(model.percent).toBe(33);
    expect(model.allDone).toBe(false);
    expect(model.rows).toHaveLength(3);
  });

  it("shows one task as quiet, then lit, then checked as its status flips mid-stream", () => {
    const flip = (status: TodoStatus) =>
      todoCardModel(
        row([{ text: "wire the pump", completed: status === "completed", status, id: "a", activeForm: "wiring the pump" }]),
        theme,
      );

    const pending = flip("pending");
    const busy = flip("in_progress");
    const done = flip("completed");

    expect(pending.rows[0]?.visual.marker).toBe("[ ]");
    expect(busy.rows[0]?.visual.marker).toBe("[•]");
    expect(done.rows[0]?.visual.marker).toBe("[✓]");
    expect(done.rows[0]?.visual.struck).toBe(true);
    expect(done.rows[0]?.visual.lit).toBe(false);

    expect(busy.rows[0]?.visual.lit).toBe(true);
    expect(busy.rows[0]?.visual.struck).toBe(false);
    expect(busy.rows[0]?.visual.backgroundColor).not.toBe(pending.rows[0]?.visual.backgroundColor);
    expect(busy.rows[0]?.showActiveForm).toBe(true);
    expect(pending.rows[0]?.showActiveForm).toBe(false);
    expect(done.rows[0]?.showActiveForm).toBe(false);

    expect(done.rows[0]?.accessibilityLabel).toBe("Done, wire the pump");
    expect(busy.rows[0]?.accessibilityLabel).toBe("In progress, wire the pump");
    expect(pending.rows[0]?.accessibilityLabel).toBe("Pending, wire the pump");
  });

  it("streams an update in place: same row keys, untouched rows identical, only the flipped row changes", () => {
    const before = todoCardModel(
      row([
        { text: "read the spec", completed: false, status: "pending", id: "a" },
        { text: "write the test", completed: false, status: "in_progress", id: "b" },
        { text: "ship it", completed: false, status: "pending", id: "c" },
      ]),
      theme,
    );
    const after = todoCardModel(
      row([
        { text: "read the spec", completed: true, status: "completed", id: "a" },
        { text: "write the test", completed: false, status: "in_progress", id: "b" },
        { text: "ship it", completed: false, status: "pending", id: "c" },
      ]),
      theme,
    );

    expect(after.rows.map((entry) => entry.id)).toEqual(before.rows.map((entry) => entry.id));
    expect(after.rows[1]?.visual).toEqual(before.rows[1]?.visual);
    expect(after.rows[2]?.visual).toEqual(before.rows[2]?.visual);
    expect(after.rows[0]?.visual.marker).not.toBe(before.rows[0]?.visual.marker);
    expect(after.completed).toBe(before.completed + 1);
    expect(before.streaming).toBe(true);
    expect(after.streaming).toBe(true);
  });

  it("drops the live footer and fills the track when the last check lands", () => {
    const done = todoCardModel(
      row(
        [
          { text: "read the spec", completed: true, status: "completed", id: "a" },
          { text: "ship it", completed: true, status: "completed", id: "c" },
        ],
        "complete",
      ),
      theme,
    );

    expect(done.allDone).toBe(true);
    expect(done.streaming).toBe(false);
    expect(done.percent).toBe(100);
    expect(done.completed).toBe(2);
  });
});

describe("todoCardModel compact phone layout (390px)", () => {
  // A realistic worst case: a long Korean task line and a long activeForm, the
  // kind of entry a planning turn actually produces.
  const stressText = "프로바이더 설정 파일에서 재시도 정책을 읽고 타임아웃을 상한으로 묶은 뒤 결과를 요약해서 보고한다";
  const compactModel = todoCardModel(
    row([
      {
        text: stressText,
        completed: false,
        status: "in_progress",
        id: "a",
        activeForm: "재시도 정책 요약 보고서 작성 중",
      },
      { text: "ship it", completed: true, status: "completed", id: "b" },
    ]),
    theme,
    { compact: true },
  );

  // Conservative glyph widths: CJK glyphs are one em wide, latin roughly 0.62.
  // Real text never measures wider than this, so fitting the estimate at 390px
  // guarantees the rendered label fits too.
  const textWidth = (text: string, fontSize: number): number =>
    [...text].reduce((width, ch) => width + ((ch.codePointAt(0) ?? 0) > 0x2e80 ? fontSize : fontSize * 0.62), 0);

  it("keeps every primary label present in the compact card", () => {
    expect(compactModel.badge.length).toBeGreaterThan(0);
    expect(compactModel.title.length).toBeGreaterThan(0);
    expect(compactModel.counter).toBe("1/2");
    expect(compactModel.footer).toBe("Working…");
    for (const entry of compactModel.rows) {
      expect(entry.visual.marker.length).toBeGreaterThan(0);
      expect(entry.text.length).toBeGreaterThan(0);
      expect(entry.accessibilityLabel).toContain(entry.text);
    }
  });

  it("keeps every label inside a 390px viewport: fixed labels fit, flexible labels truncate", () => {
    const styles = createStyles(theme, true);
    const contentWidth = 390 - styles.card.padding * 2 - styles.card.borderWidth * 2;

    // Header line one is badge and counter alone, so their combined width must
    // fit the phone content box outright.
    const headerLine =
      textWidth(compactModel.badge, styles.badge.fontSize) +
      textWidth(compactModel.counter, styles.counter.fontSize) +
      styles.header.gap;
    expect(headerLine).toBeLessThanOrEqual(contentWidth);

    // Everything flexible is line-bounded, so it wraps and then ellipsises
    // instead of ever pushing the card wider than the screen. The bound is
    // content-driven: long text clamps at two lines, short text stays one.
    expect(compactModel.titleLines).toBe(1);
    expect(compactModel.rows[0]?.textLines).toBe(2);
    expect(compactModel.rows[1]?.textLines).toBe(1);
    expect(compactModel.rows[0]?.activeFormLines).toBe(1);

    // And the smallest type on the card stays legible.
    for (const style of [styles.badge, styles.counter, styles.text, styles.title, styles.activeForm, styles.footer]) {
      expect(style.fontSize).toBeGreaterThanOrEqual(11);
    }
  });

  it("gives rows a 44px touch target in compact and leaves the desktop rows alone", () => {
    expect(createStyles(theme, true).row.minHeight).toBeGreaterThanOrEqual(44);
    expect(createStyles(theme, false).row.minHeight).toBeUndefined();
  });

  it("stacks the compact header vertically instead of squeezing it side by side", () => {
    expect(createStyles(theme, true).header.flexDirection).toBe("column");
    expect(createStyles(theme, false).header.flexDirection).toBe("row");
  });

  it("the layout.compact flag alone selects the phone treatment", () => {
    const wide = todoCardModel(
      row([{ text: "a very long task name that would wrap on a phone screen", completed: false }]),
      theme,
      { compact: false },
    );

    expect(wide.compact).toBe(false);
    expect(wide.rows[0]?.textLines).toBeNull();
    expect(compactModel.compact).toBe(true);
    expect(compactModel.rows[0]?.textLines).toBe(2);
  });
});
