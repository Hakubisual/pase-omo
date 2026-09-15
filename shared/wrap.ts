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
  "recalled-memory": "Memory",
  "ultrawork-mode": "Ultrawork",
  "system-reminder": "Notice",
  timestamp: "Time",
  "system-error": "Error",
  "system-warning": "Warning",
  "system-notice": "Notice",
  "system-info": "Info",
};

/**
 * Host envelopes around the real prompt. Strip the tags and keep processing
 * the inner text, so a nested `<memory_notice>` still becomes a Memory bar.
 */
const UNWRAP_TAGS: ReadonlySet<string> = new Set(["user_query", "user-query", "user_prompt", "user-prompt"]);

const COMPACTION_FAILURE = "Context remains above the compaction threshold because compaction did not complete";

/**
 * Tags OmO injects around the model prompt. They are not user prose, so the
 * chat should wrap them as a compact bar instead of a raw XML bubble.
 */
export function isHarnessTag(tag: string): boolean {
  const lower = tag.toLowerCase();
  if (KNOWN_BADGE[lower] !== undefined) return true;
  return /^(?:omo-|senpi-|pi-)/.test(lower) || lower.includes("memory");
}

export function isUnwrapTag(tag: string): boolean {
  return UNWRAP_TAGS.has(tag.toLowerCase());
}

function tagRe(): RegExp {
  return /<([a-z][a-z0-9:_-]*)\b[^>]*>\s*([\s\S]*?)\s*<\/\1>/gi;
}

function systemLineRe(): RegExp {
  return /\[System[ \t]+(Error|Warning|Notice|Info)\][ \t]*([^\n]*)/gi;
}

function compactionLineRe(): RegExp {
  return /(?:^|\n)[ \t]*(Context remains above the compaction threshold because compaction did not complete)[ \t]*(?=\n|$)/g;
}

function collapseBlank(text: string): string {
  return text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function unwrapEnvelopes(text: string): string {
  let current = text;
  for (let pass = 0; pass < 8; pass++) {
    const next = current.replace(tagRe(), (full, tag: string, body: string) => (isUnwrapTag(tag) ? body : full));
    if (next === current) break;
    current = next;
  }
  return current;
}

type Hit = { start: number; end: number; wrap: HarnessWrap | null };

function xmlHits(source: string): Hit[] {
  const hits: Hit[] = [];
  for (const match of source.matchAll(tagRe())) {
    const tag = match[1] ?? "";
    if (!isHarnessTag(tag)) continue;
    const body = (match[2] ?? "").trim();
    const start = match.index ?? 0;
    hits.push({
      start,
      end: start + match[0].length,
      wrap: body.length > 0 ? { tag: tag.toLowerCase(), body } : null,
    });
  }
  return hits;
}

function systemHits(source: string): Hit[] {
  const hits: Hit[] = [];
  for (const match of source.matchAll(systemLineRe())) {
    const kind = (match[1] ?? "Error").toLowerCase();
    const body = (match[2] ?? "").trim();
    const start = match.index ?? 0;
    hits.push({
      start,
      end: start + match[0].length,
      wrap: { tag: `system-${kind}`, body: body.length > 0 ? body : `System ${match[1] ?? "Error"}` },
    });
  }
  for (const match of source.matchAll(compactionLineRe())) {
    const body = match[1] ?? COMPACTION_FAILURE;
    const full = match[0];
    const leading = full.length - full.trimStart().length;
    const start = (match.index ?? 0) + leading;
    hits.push({
      start,
      end: start + body.length,
      wrap: { tag: "system-error", body },
    });
  }
  return hits;
}

function keepNonOverlapping(hits: Hit[]): Hit[] {
  const ordered = [...hits].sort((a, b) => a.start - b.start || a.end - b.end);
  const kept: Hit[] = [];
  let cursor = 0;
  for (const hit of ordered) {
    if (hit.start < cursor) continue;
    kept.push(hit);
    cursor = hit.end;
  }
  return kept;
}

/**
 * Pulls harness XML, host timestamps, and `[System Error]` lines out of a
 * timeline string.
 *
 * Remaining text is the original minus every matched wrap, empty tags
 * included, so a prompt that is only `<omo-senpi-task>…</omo-senpi-task>` does
 * not survive as a user bubble. Blocks with no inner text are stripped but not
 * wrapped — there is nothing to put on the bar. `<user_query>` is an envelope:
 * the tags disappear and the inner text is split again.
 */
export function splitHarnessWraps(text: string): SplitHarness {
  const source = unwrapEnvelopes(text);
  const kept = keepNonOverlapping([...xmlHits(source), ...systemHits(source)]);
  const wraps: HarnessWrap[] = [];
  let remaining = "";
  let last = 0;
  for (const hit of kept) {
    remaining += source.slice(last, hit.start);
    if (hit.wrap !== null) wraps.push(hit.wrap);
    last = hit.end;
  }
  remaining += source.slice(last);
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
const KIBITZER_PREAMBLE = /^Kibitzer recalled a stored memory\.[^\n]*/i;

export function summarizeHarness(body: string): string {
  const stripped = body.replace(KIBITZER_PREAMBLE, "").trim();
  const lines = (stripped.length > 0 ? stripped : body).split(/\r?\n/);
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

function sourceText(item: unknown): string {
  if (typeof item !== "object" || item === null) return "";
  const rec = item as { text?: unknown; message?: unknown };
  if (typeof rec.text === "string") return rec.text;
  if (typeof rec.message === "string") return rec.message;
  return "";
}

/**
 * Turns a user/assistant/error timeline item into wrap rows when the text is
 * only harness XML or a `[System Error]` line. Mixed messages are left alone
 * so the native bubble stays; the provider splits those before they reach the
 * timeline.
 */
export function wrapPluginItems(item: unknown): { items: WrapPluginItem[] } | undefined {
  const { wraps, remaining } = splitHarnessWraps(sourceText(item));
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
