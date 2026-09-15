import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "./senpi-types.js";
import { Type, type Static } from "typebox";
import { bridgeErrorJson, invokeWorkers, type BridgeOptions } from "../server/workers/chat-bridge.js";

const text = () => Type.String({ minLength: 1 });
export const WorkersToolParams = Type.Union([
  Type.Object({ action: Type.Literal("launch"), repoRoot: text(), workers: Type.Array(Type.Object({
    id: text(), title: text(), prompt: text(), model: Type.Optional(text()),
    branch: Type.Optional(text()), dependsOn: Type.Optional(Type.Array(text())),
  }, { additionalProperties: false }), { minItems: 1 }) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("list") }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("cancel"), workerId: text() }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("get"), workerId: text() }, { additionalProperties: false }),
]);

export function registerWorkersTool(pi: Pick<ExtensionAPI, "registerTool">, options: Omit<BridgeOptions, "signal"> = {}) {
  const tool = {
    name: "paseo_workers",
    label: "Paseo workers",
    description: "Launch, list, inspect, or cancel terminal workers through the Paseo omo-workers plugin for this exact OmO session. Launch requires repoRoot and worker id/title/prompt; dependencies reference worker ids. Omitted models inherit the persisted parent model when available. A timeout does not confirm cancellation; list before retrying launch.",
    parameters: WorkersToolParams,
    async execute(
      _toolCallId: string,
      params: Static<typeof WorkersToolParams>,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: { readonly sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId"> },
    ) {
      try {
        const output = await invokeWorkers(params, { sessionId: ctx.sessionManager.getSessionId() }, { ...options, signal });
        return { content: [{ type: "text" as const, text: JSON.stringify(output) }], details: output };
      } catch (error) {
        const output = bridgeErrorJson(error);
        return { content: [{ type: "text" as const, text: JSON.stringify(output) }], details: output, isError: true };
      }
    },
  } satisfies ToolDefinition<typeof WorkersToolParams>;
  pi.registerTool(tool);
  return tool;
}

export default function paseoWorkersExtension(pi: Pick<ExtensionAPI, "registerTool">) {
  return registerWorkersTool(pi);
}
