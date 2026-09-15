/**
 * Minimal structural types for the OmO (senpi) extension API.
 *
 * This extension only ever touches `registerTool` and
 * `sessionManager.getSessionId`, so declaring that shape locally keeps the
 * repository installable and type-checkable without a machine-local senpi
 * checkout. A real senpi build stays assignable to these.
 */

export interface ToolDefinition<Parameters> {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: Parameters;
  execute(
    toolCallId: string,
    params: never,
    signal: AbortSignal | undefined,
    onUpdate: never,
    ctx: never,
  ): unknown;
}

export interface ExtensionAPI {
  registerTool(tool: unknown): unknown;
}

export interface ExtensionContext {
  readonly sessionManager: { getSessionId(): string };
}
