/** One todo entry as the timeline item carries it. */
export type TodoPublishItem = {
  text: string;
  completed: boolean;
  status?: "pending" | "in_progress" | "completed";
};

export type TodoPublishDecision = {
  publish: boolean;
  signature: string;
  items: TodoPublishItem[];
};

function signatureOf(items: readonly TodoPublishItem[]): string {
  return JSON.stringify(
    items.map((item) => [item.text, item.status ?? (item.completed ? "completed" : "pending")]),
  );
}

/**
 * Remembers the latest todo list without drawing it.
 *
 * Every publication of a `todo` item becomes its own row in Paseo's timeline -
 * unlike a streaming assistant message, a repeated id does not rewrite the card
 * - so publishing each change is what stacked five near-identical lists down
 * the chat. Live progress is not lost by holding them: Paseo shows the running
 * count in the composer itself while the turn works.
 */
export function holdTodo(items: readonly TodoPublishItem[]): TodoPublishDecision {
  return { publish: false, signature: signatureOf(items), items: [...items] };
}

/**
 * The one card a finished turn draws, when it has something new to say.
 *
 * Returns publish=false when the turn touched no list, or ended on exactly the
 * card already in the conversation.
 */
export function finalTodoPublication(
  previousSignature: string | undefined,
  pending: readonly TodoPublishItem[] | undefined,
): { publish: boolean; signature: string | undefined; items?: TodoPublishItem[] } {
  if (pending === undefined || pending.length === 0) return { publish: false, signature: previousSignature };
  const signature = signatureOf(pending);
  if (signature === previousSignature) return { publish: false, signature };
  return { publish: true, signature, items: [...pending] };
}
