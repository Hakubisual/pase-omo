import { z } from "zod";

/** Timeline row kind published for an agent's own todo list. */
export const TODO_ROW_KIND = "omo-todo";
export const TODO_ROW_VERSION = 1;

export const TODO_STATUSES = ["pending", "in_progress", "completed"] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

export const TodoEntrySchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  status: z.enum(TODO_STATUSES),
  activeForm: z.string().optional(),
});

export const TodoRowSchema = z.object({
  entries: z.array(TodoEntrySchema),
  total: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  phase: z.enum(["streaming", "complete"]),
});

export type TodoEntry = z.infer<typeof TodoEntrySchema>;
export type TodoRow = z.infer<typeof TodoRowSchema>;

/**
 * The same row, typed so the host can accept it as `JsonValue`.
 *
 * An inferred `activeForm?: string` widens to `string | undefined`, and
 * `undefined` is not JSON, so the optional field is modelled as a union of
 * "absent" and "present" instead. The runtime value is identical — the key is
 * simply never written when there is nothing to put in it.
 */
export type TodoEntryJson =
  | { id: string; text: string; status: TodoStatus }
  | { id: string; text: string; status: TodoStatus; activeForm: string };

export type TodoRowJson = {
  entries: TodoEntryJson[];
  total: number;
  completed: number;
  phase: "streaming" | "complete";
};

const KNOWN: ReadonlySet<string> = new Set(TODO_STATUSES);

/**
 * One protocol task item, narrowed to something the card can draw.
 *
 * `status` is optional in the protocol and `completed` is the older signal, so
 * the explicit status wins where it exists: it is the only field that can say
 * "this one is happening right now", which is the whole point of the card.
 */
function entryOf(raw: unknown, index: number): TodoEntryJson | null {
  if (typeof raw !== "object" || raw === null) return null;
  const item = raw as { text?: unknown; completed?: unknown; id?: unknown; status?: unknown; activeForm?: unknown };

  const text = typeof item.text === "string" && item.text.length > 0 ? item.text : null;
  // A row with no text would render as an empty checkbox, which reads as a bug.
  if (text === null) return null;

  const declared = typeof item.status === "string" && KNOWN.has(item.status) ? (item.status as TodoStatus) : null;
  const status: TodoStatus = declared ?? (item.completed === true ? "completed" : "pending");
  const id = typeof item.id === "string" && item.id.length > 0 ? item.id : `entry-${index}`;
  const activeForm = typeof item.activeForm === "string" && item.activeForm.length > 0 ? item.activeForm : null;

  return activeForm === null ? { id, text, status } : { id, text, status, activeForm };
}

/**
 * Builds the card payload from a `todo` timeline item's `items` array.
 *
 * Returns null rather than an empty card whenever there is nothing worth
 * drawing, which is how the transformer decides to leave the built-in row alone.
 */
export function toTodoRow(items: unknown, phase: "streaming" | "complete"): TodoRowJson | null {
  if (!Array.isArray(items)) return null;

  const entries = items
    .map((item, index) => entryOf(item, index))
    .filter((entry): entry is TodoEntryJson => entry !== null);
  if (entries.length === 0) return null;

  return {
    entries,
    // Counts come from the entries actually drawn, so the header can never
    // promise a row the list does not show.
    total: entries.length,
    completed: entries.filter((entry) => entry.status === "completed").length,
    phase,
  };
}

export type TodoPluginItem = {
  type: "plugin";
  kind: typeof TODO_ROW_KIND;
  version: typeof TODO_ROW_VERSION;
  data: TodoRowJson;
  /** Present whenever the source item has an id of its own. */
  id?: string;
};

/**
 * The transform result for one `todo` timeline item.
 *
 * Exactly one item is emitted, pinned to the SOURCE item's id. The transformer
 * runs once while the turn streams and again when it completes, and an emitted
 * item with no id is a new card each time - which is how one published list
 * ended up drawn twice in the chat. Sharing the source id collapses both phases
 * onto one card that updates in place.
 */
export function todoPluginItems(
  item: unknown,
  phase: "streaming" | "complete",
): { items: TodoPluginItem[] } | undefined {
  const source = (item as { items?: unknown } | null)?.items;
  const row = toTodoRow(source, phase);
  if (row === null) return undefined;

  const sourceId = (item as { id?: unknown } | null)?.id;
  const base: TodoPluginItem = {
    type: "plugin",
    kind: TODO_ROW_KIND,
    version: TODO_ROW_VERSION,
    data: row,
  };
  return {
    items: [typeof sourceId === "string" && sourceId.length > 0 ? { ...base, id: sourceId } : base],
  };
}
