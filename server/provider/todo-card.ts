import type { PluginHookAgent, PluginHookContext } from "@getpaseo/plugin/server";

import { TODO_ROW_KIND, TODO_ROW_VERSION, toTodoRow } from "../../shared/todo.js";
import type { OmoSessionRegistry } from "./session-registry.js";

/**
 * Draws the todo card a finished turn left, replacing the one already in chat.
 *
 * A plugin row appended again under the same id replaces the earlier row, so a
 * session keeps exactly one todo card and it always shows the latest list. The
 * provider's own `todo` timeline item cannot do that: every one of those is
 * another row, which is how a long session ended in a stack of identical cards.
 */
export async function publishTodoCard(
  registry: OmoSessionRegistry,
  agent: PluginHookAgent,
  context: PluginHookContext,
): Promise<void> {
  if (!agent.provider.toLowerCase().includes("omo")) return;
  const session = await registry.forAgent(agent.id, context);
  const card = session.takeTodoCard();
  if (card === undefined) return;
  const data = toTodoRow(card.items, "complete");
  if (data === null) return;
  await context.paseo.agents.ref(agent.id).timeline.append({
    type: "plugin",
    id: card.id,
    kind: TODO_ROW_KIND,
    version: TODO_ROW_VERSION,
    data,
  });
  await session.acknowledgeTodoCard(card.items);
}
