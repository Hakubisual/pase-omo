import { z } from "zod";

/** Timeline row kind for a compact OmO harness wrap, like the TUI usage bar. */
export const WRAP_ROW_KIND = "omo-wrap";
export const WRAP_ROW_VERSION = 1;

export const WrapRowSchema = z.object({
  tag: z.string().min(1),
  badge: z.string().min(1),
  summary: z.string().min(1),
});

export type WrapRow = z.infer<typeof WrapRowSchema>;

/** JSON shape with no optional keys, so it stays a `JsonValue`. */
export type WrapRowJson = {
  tag: string;
  badge: string;
  summary: string;
};

export type HarnessWrap = {
  tag: string;
  body: string;
};

export type SplitHarness = {
  remaining: string;
  wraps: HarnessWrap[];
};

export type WrapPluginItem = {
  type: "plugin";
  kind: typeof WRAP_ROW_KIND;
  version: typeof WRAP_ROW_VERSION;
  data: WrapRowJson;
  id?: string;
};

const KNOWN_BADGE: Readonly<Record<string, string>> = {
  "omo-senpi-task": "Task",
  memory_notice: "Memory",
  memory_metadata: "Memory",
  "ultrawork-mode": "Ultrawork",
  "system-reminder": "Notice",
};

/**
 * Tags OmO injects around the model prompt. They are not user prose, so the
 * chat should wrap them as a compact bar instead of a raw XML bubble.
 */
export function isHarnessTag(tag: string): boolean {
  const lower = tag.toLowerCase();
  if (KNOWN_BADGE[lower] !== undefined) return true;
  return /^(?:omo-|senpi-|pi-)/.test(lower) || lower.startsWith("memory_");
}

function tagRe(): RegExp {
  return /<([a-z][a-z0-9:_-]*)\b[^>]*>\s*([\s\S]*?)\s*<\/\1>/gi;
}

function collapseBlank(text: string): string {
  return text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Pulls harness XML blocks out of a timeline string.
 *
 * Remaining text is the original minus every matched harness block, empty tags
 * included, so a prompt that is only `<omo-senpi-task>…</omo-senpi-task>` does
 * not survive as a user bubble. Blocks with no inner text are stripped but not
 * wrapped — there is nothing to put on the bar.
 */
export function splitHarnessWraps(text: string): SplitHarness {
  const wraps: HarnessWrap[] = [];
  const remaining = text.replace(tagRe(), (full, tag: string, body: string) => {
    if (!isHarnessTag(tag)) return full;
    const trimmed = body.trim();
    if (trimmed.length > 0) wraps.push({ tag: tag.toLowerCase(), body: trimmed });
    return "";
  });
  return { remaining: collapseBlank(remaining), wraps };
}

export function badgeFor(tag: string): string {
  const lower = tag.toLowerCase();
  const known = KNOWN_BADGE[lower];
  if (known !== undefined) return known;
  const leaf = lower.split(/[:/]/).pop() ?? lower;
  const word = leaf.replace(/^(?:omo-|senpi-|pi-)/, "").replace(/[_-]+/g, " ").trim();
  if (word.length === 0) return "OmO";
  return word.replace(/\b[a-z]/g, (char) => char.toUpperCase());
}

/**
 * First prose paragraph, so the bar reads like the TUI usage line instead of
 * dumping the whole XML body. Bullet lists after that paragraph stay off-screen.
 */
export function summarizeHarness(body: string): string {
  const lines = body.split(/\r?\n/);
  const collected: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      if (collected.length > 0) break;
      continue;
    }
    if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      if (collected.length === 0) collected.push(trimmed.slice(2).trim());
      break;
    }
    collected.push(trimmed);
  }
  return collected.join(" ").replace(/\s+/g, " ").trim();
}

export function toWrapRow(wrap: HarnessWrap): WrapRowJson | null {
  const summary = summarizeHarness(wrap.body);
  if (summary.length === 0) return null;
  return { tag: wrap.tag, badge: badgeFor(wrap.tag), summary };
}

/**
 * Turns a user/assistant timeline item into wrap rows when the text is only
 * harness XML. Mixed messages are left alone so the native bubble stays;
 * the provider splits those before they reach the timeline.
 */
export function wrapPluginItems(item: unknown): { items: WrapPluginItem[] } | undefined {
  const text = typeof (item as { text?: unknown } | null)?.text === "string" ? (item as { text: string }).text : "";
  const { wraps, remaining } = splitHarnessWraps(text);
  if (wraps.length === 0 || remaining.length > 0) return undefined;

  const sourceId = (item as { id?: unknown } | null)?.id;
  const stableId = typeof sourceId === "string" && sourceId.length > 0 ? sourceId : null;
  const items: WrapPluginItem[] = [];
  for (const [index, wrap] of wraps.entries()) {
    const data = toWrapRow(wrap);
    if (data === null) continue;
    const base: WrapPluginItem = {
      type: "plugin",
      kind: WRAP_ROW_KIND,
      version: WRAP_ROW_VERSION,
      data,
    };
    const id = stableId === null ? undefined : wraps.length === 1 ? stableId : `${stableId}-wrap-${index}`;
    items.push(id === undefined ? base : { ...base, id });
  }
  return items.length === 0 ? undefined : { items };
}
