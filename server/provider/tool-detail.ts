import type { ProviderToolCallDetail } from "@getpaseo/plugin/server/provider";

type Json = Record<string, unknown>;

function str(value: unknown, limit = 200_000): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.length > limit ? `${value.slice(0, limit)}\n… truncated` : value;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** OmO tool results are `{ content: [{ type: "text", text }], details }`. */
export function toolResultText(result: unknown): string | undefined {
  if (typeof result === "string") return str(result);
  if (typeof result !== "object" || result === null) return undefined;
  const content = (result as Json).content;
  if (!Array.isArray(content)) return str((result as Json).text);
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "object" && part !== null) {
      const text = (part as Json).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.length > 0 ? str(parts.join("\n")) : undefined;
}

function args(value: unknown): Json {
  return typeof value === "object" && value !== null ? (value as Json) : {};
}

/**
 * Task id out of a `task` result.
 *
 * The tool answers in prose ("Started task … (st_01a0b4c9, running)"), and a
 * batch spawn names several; the first one is the row's own child. Ids are
 * `st_` plus hex, so the pattern cannot swallow a neighbouring word.
 */
export function spawnedTaskId(output: string | undefined): string | undefined {
  const match = /\bst_[0-9a-f]{6,}\b/i.exec(output ?? "");
  return match?.[0];
}

/**
 * Map an OmO tool call onto Paseo's rich tool-call renderers.
 *
 * Names come from omo's builtin tool surface; anything unrecognised (including
 * MCP tools, which arrive namespaced) falls back to a readable plain-text row.
 */
export function toolCallDetail(toolName: string, rawArgs: unknown, output?: string): ProviderToolCallDetail {
  const input = args(rawArgs);
  const name = toolName.toLowerCase();

  switch (name) {
    case "bash": {
      const command = str(input.command) ?? "";
      return {
        type: "shell",
        command,
        ...(str(input.cwd) ? { cwd: str(input.cwd) as string } : {}),
        ...(output ? { output } : {}),
      };
    }
    case "eval": {
      const language = str(input.language) ?? "js";
      const code = str(input.code) ?? "";
      return { type: "shell", command: `# eval (${language})\n${code}`, ...(output ? { output } : {}) };
    }
    case "read": {
      const filePath = str(input.path) ?? str(input.filePath) ?? "";
      return {
        type: "read",
        filePath,
        ...(output ? { content: output } : {}),
        ...(num(input.offset) !== undefined ? { offset: num(input.offset) as number } : {}),
        ...(num(input.limit) !== undefined ? { limit: num(input.limit) as number } : {}),
      };
    }
    case "write": {
      return {
        type: "write",
        filePath: str(input.path) ?? str(input.filePath) ?? "",
        ...(str(input.content) ? { content: str(input.content) as string } : {}),
      };
    }
    case "edit": {
      const filePath = str(input.path) ?? str(input.filePath) ?? "";
      const edits = Array.isArray(input.edits) ? input.edits : [];
      const first = edits.length > 0 && typeof edits[0] === "object" && edits[0] !== null ? (edits[0] as Json) : undefined;
      const oldString = str(input.oldText) ?? str(first?.oldText);
      const newString = str(input.newText) ?? str(first?.newText);
      return {
        type: "edit",
        filePath,
        ...(oldString !== undefined ? { oldString } : {}),
        ...(newString !== undefined ? { newString } : {}),
      };
    }
    case "web_search": {
      return {
        type: "search",
        query: str(input.query) ?? "",
        toolName: "web_search",
        ...(output ? { content: output } : {}),
      };
    }
    case "webfetch": {
      return {
        type: "fetch",
        url: str(input.url) ?? "",
        ...(output ? { result: output } : {}),
      };
    }
    case "task": {
      const description = str(input.task_summary) ?? str(input.description) ?? str(input.prompt, 400);
      // The spawned task's own id, which is also the id the provider announces
      // the child session under - so the row's "session" link lands on the
      // subagent the panel shows rather than nothing.
      const childSessionId = spawnedTaskId(output);
      return {
        type: "sub_agent",
        ...(str(input.category) || str(input.subagent_type)
          ? { subAgentType: (str(input.category) ?? str(input.subagent_type)) as string }
          : {}),
        ...(description ? { description } : {}),
        ...(childSessionId ? { childSessionId } : {}),
        log: output ?? "",
      };
    }
    case "grep":
    case "glob":
    case "tool_search": {
      return {
        type: "search",
        query: str(input.query) ?? str(input.pattern) ?? "",
        toolName: name === "glob" ? "glob" : name === "grep" ? "grep" : "search",
        ...(output ? { content: output } : {}),
      };
    }
    default: {
      const summary = str(input.summary, 400) ?? str(input.description, 400);
      const printable = Object.keys(input).length > 0 ? JSON.stringify(input, null, 1).slice(0, 4000) : "";
      const text = [summary, printable, output].filter(Boolean).join("\n\n");
      return { type: "plain_text", label: toolName, ...(text ? { text } : {}), icon: "wrench" };
    }
  }
}

/** An OmO `todo` item as Paseo's timeline protocol accepts it. */
type TodoItemDetail = {
  text: string;
  completed: boolean;
  status?: "pending" | "in_progress" | "completed";
};

/** The timeline statuses, without the optionality of the item field. */
type TodoStatusValue = NonNullable<TodoItemDetail["status"]>;

/** Statuses the timeline item cannot express, settled as completed. */
const TERMINAL_TODO_STATUSES: ReadonlySet<string> = new Set(["completed", "abandoned", "cancelled"]);
const LIVE_TODO_STATUSES: ReadonlySet<string> = new Set(["pending", "in_progress", "completed"]);

/**
 * The phases of a `todo` tool result.
 *
 * senpi's builtin returns `{ content: [{ type: "text", text }], details }`
 * whose `details.phases` is the authoritative post-op list:
 * `[{ name, tasks: [{ content, status }] }]`. A bare phases array is accepted
 * too, because it is the only part of the result the todo row needs.
 */
function resultPhases(result: unknown): unknown[] | undefined {
  if (Array.isArray(result)) return result;
  if (typeof result !== "object" || result === null) return undefined;
  const details = (result as Json).details;
  if (typeof details !== "object" || details === null) return undefined;
  const phases = (details as Json).phases;
  return Array.isArray(phases) ? phases : undefined;
}

/**
 * OmO's `todo` tool results carry the live list; surface it as Paseo's todo row.
 *
 * The ARGUMENTS only ever hold the initial `list` of plain strings, so every
 * status a turn transitions through lives in the tool RESULT's
 * `details.phases` — that is the only place "completed" can come from. When
 * the result is absent (a `tool_execution_start` snapshot) or malformed, the
 * arguments stand in and the list renders honestly all-pending.
 */
export function todoItems(rawArgs: unknown, result?: unknown): TodoItemDetail[] | undefined {
  const phases = resultPhases(result);
  if (phases !== undefined) {
    const items: TodoItemDetail[] = [];
    for (const phase of phases) {
      if (typeof phase !== "object" || phase === null) continue;
      const phaseName = str((phase as Json).name, 80);
      const tasks = (phase as Json).tasks;
      if (!Array.isArray(tasks)) continue;
      for (const task of tasks) {
        if (typeof task === "string") {
          items.push({ text: phaseName ? `${phaseName}: ${task}` : task, completed: false, status: "pending" });
          continue;
        }
        if (typeof task !== "object" || task === null) continue;
        const content = (task as Json).content;
        if (typeof content !== "string" || content.trim().length === 0) continue;
        const declared = typeof (task as Json).status === "string" ? ((task as Json).status as string) : undefined;
        const text = phaseName ? `${phaseName}: ${content}` : content;
        if (declared !== undefined && TERMINAL_TODO_STATUSES.has(declared)) {
          // Deliberately dropped work (abandoned/cancelled) is terminal by
          // choice; settling it as completed keeps "N left" honest.
          items.push({ text, completed: true, status: "completed" });
        } else if (declared !== undefined && LIVE_TODO_STATUSES.has(declared)) {
          items.push({ text, completed: declared === "completed", status: declared as TodoStatusValue });
        } else {
          // An unfamiliar status degrades to pending instead of poisoning the
          // card with a value the renderer has no treatment for.
          items.push({ text, completed: false, status: "pending" });
        }
      }
    }
    if (items.length > 0) return items;
    // A result whose phases carry nothing usable falls through to the arguments.
  }

  const input = args(rawArgs);
  const list = input.list;
  if (!Array.isArray(list)) return undefined;
  const items: TodoItemDetail[] = [];
  for (const phase of list) {
    if (typeof phase !== "object" || phase === null) continue;
    const entries = (phase as Json).items;
    const phaseName = str((phase as Json).phase, 80);
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (typeof entry !== "string") continue;
      items.push({ text: phaseName ? `${phaseName}: ${entry}` : entry, completed: false, status: "pending" });
    }
  }
  return items.length > 0 ? items : undefined;
}
