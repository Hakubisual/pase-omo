import type {
  ProviderConfigState,
  ProviderEvent,
  ProviderModel,
  ProviderPermissionResponse,
  ProviderSessionConfig,
  ProviderSetting,
  ProviderThinkingOption,
  ProviderTimelineItem,
} from "@getpaseo/plugin/server/provider";
import type { ApprovalResponse, PendingApprovalRequest } from "../../shared/approval.js";
import { omoSessionRegistry } from "./session-registry.js";
import type { OmoLaunch } from "./omo-cli.js";
import { type OmoEvent, OmoProcess } from "./omo-process.js";
import { todoItems, toolCallDetail, toolResultText } from "./tool-detail.js";
import { finalTodoPublication, holdTodo, type TodoPublishItem } from "./todo-publish.js";
import { visibleTimelineItems } from "./text-wrap.js";

type Json = Record<string, unknown>;

const STREAM_FLUSH_MS = 60;

/**
 * How long a suspend waits for the old child to exit before moving on. `stop()`
 * closes stdin and kills after its own backstop, so this only bounds the case
 * where the process is already unreachable.
 */
const PROCESS_EXIT_GRACE_MS = 5_000;

function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    void promise.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Thinking levels OmO understands, ordered from cheapest to most expensive. */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export const OMO_MODES = [
  { id: "default", label: "Ask", description: "OmO asks before risky tool calls" },
  { id: "auto", label: "Auto-approve", description: "Pre-approve tool calls", isUnattended: true },
] as const;

export interface OmoModelRecord {
  id: string;
  name?: string;
  provider: string;
  reasoning?: boolean;
  contextWindow?: number;
  supportedThinkingLevels?: string[];
}

export interface OmoStateRecord {
  model?: { id: string; provider: string; name?: string; contextWindow?: number };
  thinkingLevel?: string;
  fastMode?: boolean;
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  cwd?: string;
}

export interface OmoCommandRecord {
  name: string;
  description?: string;
  syntax?: string;
}

/** Paseo model ids are flat strings; OmO addresses a model by provider + id. */
export function encodeModelId(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

export function decodeModelId(value: string): { provider: string; modelId: string } | undefined {
  const index = value.indexOf("/");
  if (index <= 0 || index === value.length - 1) return undefined;
  return { provider: value.slice(0, index), modelId: value.slice(index + 1) };
}

export function toProviderModels(records: readonly OmoModelRecord[]): ProviderModel[] {
  return records.map((record) => {
    const levels = (record.supportedThinkingLevels ?? []).filter((level) =>
      (THINKING_LEVELS as readonly string[]).includes(level),
    );
    const thinkingOptions: ProviderThinkingOption[] = levels.map((level) => ({ id: level, label: thinkingLabel(level) }));
    return {
      id: encodeModelId(record),
      label: record.name ?? record.id,
      ...(record.contextWindow ? { contextWindowMaxTokens: record.contextWindow } : {}),
      ...(thinkingOptions.length > 0 ? { thinkingOptions } : {}),
    };
  });
}

export function thinkingLabel(level: string): string {
  if (level === "off") return "Off";
  return level.charAt(0).toUpperCase() + level.slice(1);
}

export function allThinkingOptions(models: readonly ProviderModel[]): ProviderThinkingOption[] {
  const seen = new Set<string>();
  for (const model of models) for (const option of model.thinkingOptions ?? []) seen.add(option.id);
  return THINKING_LEVELS.filter((level) => seen.has(level)).map((level) => ({ id: level, label: thinkingLabel(level) }));
}

/**
 * Env var carrying this client's RPC capabilities to the OmO child, comma
 * separated.
 */
const RPC_CLIENT_CAPABILITIES_ENV = "SENPI_RPC_CLIENT_CAPABILITIES";

/**
 * OmO sends `extension_ui_request{method:"question"}` only to a client that
 * advertised it; a client that stays quiet gets the old behaviour, where a
 * question never reaches the UI at all.
 *
 * Confirmations and selections are not gated, which is why those always worked
 * while the panel's question branch sat waiting for an event that could not
 * arrive. Advertising is additive and idempotent: a capability list set by the
 * environment keeps everything it already asked for.
 */
export function withQuestionCapability(existing: string | undefined): string {
  const advertised = (existing ?? "")
    .split(",")
    .map((capability) => capability.trim())
    .filter((capability) => capability.length > 0);
  return advertised.includes("question")
    ? advertised.join(",")
    : [...advertised, "question"].join(",");
}

interface PendingUi {
  method: "confirm" | "select" | "question";
  title: string;
  /** Option label per action id, for select and question. */
  optionByAction: Map<string, string>;
  /** Question key used by `extension_ui_response.answers`. */
  questionKey?: string;
}

export interface OmoSessionOptions {
  paseoSessionId: string;
  launch: OmoLaunch;
  config: ProviderSessionConfig;
  /** Negotiated connection capabilities, echoed back on `session.opened`. */
  capabilities: readonly string[];
  sessionFile?: string;
  emit(event: ProviderEvent): void;
  log(message: string): void;
  onRuntimeFailure(error: string): void;
}

/**
 * One Paseo session backed by one `omo --mode rpc` child.
 *
 * OmO streams cumulative-free deltas; Paseo wants complete snapshots per
 * timeline item id, so this class keeps the running text per item and republishes
 * the whole item, throttled while streaming and flushed on every boundary.
 */
export class OmoSession {
  proc: OmoProcess;
  private readonly options: OmoSessionOptions;
  private config: ProviderSessionConfig;
  private models: ProviderModel[] = [];
  private state: OmoStateRecord = {};
  private commands: OmoCommandRecord[] = [];

  private turnSeq = 0;
  private messageSeq = 0;
  private activeTurnId: string | null = null;
  private readonly textBuffers = new Map<string, string>();
  private readonly flushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly toolCalls = new Map<string, { name: string; args: unknown }>();
  private readonly pendingUi = new Map<string, PendingUi>();
  /** Rendered content of the last todo card published for this session. */
  private lastTodoSignature: string | undefined;
  /** Latest list seen this turn, drawn once when the turn ends. */
  private pendingTodoItems: TodoPublishItem[] | undefined;
  private readonly unregisterSession: () => void;
  private closed = false;
  /** True between `suspend()` and `resume()`, when no child process exists. */
  private suspended = false;

  constructor(options: OmoSessionOptions) {
    this.options = options;
    this.config = options.config;
    this.proc = this.createProcess(options.sessionFile);
    this.unregisterSession = omoSessionRegistry.add(this);
  }

  /**
   * A child speaking for this session, resuming `sessionFile` when one is known.
   *
   * Built here rather than inline in the constructor because `resume()` needs an
   * identical child around the session file the previous one was writing.
   */
  private createProcess(sessionFile: string | undefined): OmoProcess {
    const { options } = this;
    return new OmoProcess({
      launch: options.launch,
      args: this.spawnArgs(sessionFile),
      cwd: options.config.cwd,
      env: {
        ...(process.env as Record<string, string>),
        ...options.config.env,
        NO_COLOR: "1",
        [RPC_CLIENT_CAPABILITIES_ENV]: withQuestionCapability(
          options.config.env?.[RPC_CLIENT_CAPABILITIES_ENV] ?? process.env[RPC_CLIENT_CAPABILITIES_ENV],
        ),
      },
      onEvent: (event) => this.handleEvent(event),
      onExit: ({ code, stderr }) => {
        // A suspended session asked for this exit; reporting it would surface
        // the pause as a crash and mark the agent failed in Paseo.
        if (this.closed || this.suspended) return;
        const detail = stderr.trim().split("\n").slice(-4).join("\n");
        options.onRuntimeFailure(`OmO exited with code ${code ?? "null"}${detail ? `: ${detail}` : ""}`);
      },
      log: options.log,
    });
  }

  get sessionId(): string {
    return this.options.paseoSessionId;
  }

  get durableSessionFile(): string | undefined {
    return this.state.sessionFile ?? this.options.sessionFile;
  }

  /**
   * Timeline id of this session's live todo card.
   *
   * Stable for the session so repeated `todo` calls rewrite one card instead of
   * appending another copy of the same list.
   */
  private get todoItemId(): string {
    return `todo-${this.sessionId}`;
  }

  getPendingUiRequests(): PendingApprovalRequest[] {
    return [...this.pendingUi].map(([id, pending]) => ({
      id,
      method: pending.method,
      title: pending.title,
      options: [...pending.optionByAction].map(([action, label]) => ({ action, label })),
      ...(pending.questionKey ? { questionKey: pending.questionKey } : {}),
    }));
  }

  private spawnArgs(sessionFile: string | undefined): string[] {
    const args = ["--mode", "rpc"];
    if (sessionFile) args.push("--session", sessionFile);
    const model = this.config.model ? decodeModelId(this.config.model) : undefined;
    if (model) args.push("--provider", model.provider, "--model", model.modelId);
    if (this.config.thinkingOption) args.push("--thinking", this.config.thinkingOption);
    if (this.config.mode === "auto") args.push("--approve");
    if (this.config.systemPrompt) args.push("--append-system-prompt", this.config.systemPrompt);
    return args;
  }

  private emit(event: ProviderEvent): void {
    if (this.closed && event.type !== "session.closed") return;
    this.options.emit(event);
  }

  private item(item: ProviderTimelineItem): void {
    this.emit({ type: "timeline.item", sessionId: this.sessionId, item });
  }

  /** Publish user/assistant text, wrapping OmO harness XML as compact bars. */
  private publishVisibleText(
    role: "user" | "assistant",
    id: string,
    text: string,
    extra?: { clientMessageId: string },
  ): void {
    for (const item of visibleTimelineItems(role, id, text, extra)) this.item(item);
  }

  /** Spawn, wait for the agent session to exist, and publish the opened state. */
  async open(requestId: string, history: "replay" | "skip"): Promise<void> {
    this.proc.start();
    this.state = await this.proc.call<OmoStateRecord>("get_state", {}, 240_000);
    await this.refreshCatalog();

    // Hoisted: under exactOptionalPropertyTypes a second call to persistence()
    // inside the spread is not narrowed by the guard, so the optional property
    // would widen back to `| undefined`.
    const persistence = this.persistence();
    const { title } = this.config;

    this.emit({
      type: "session.opened",
      requestId,
      sessionId: this.sessionId,
      capabilities: this.options.capabilities,
      restoration: "core",
      ...(persistence ? { persistence } : {}),
      ...(title ? { title } : {}),
      cwd: this.config.cwd,
    });
    this.emit({ type: "session.config", sessionId: this.sessionId, config: this.configState() });
    this.publishCommands();
    if (history === "replay") await this.replay();
    this.emit({ type: "session.ready", requestId, sessionId: this.sessionId });
  }

  private persistence(): { version: number; data: { sessionFile: string } } | undefined {
    const file = this.durableSessionFile;
    return file ? { version: 1, data: { sessionFile: file } } : undefined;
  }

  private async refreshCatalog(): Promise<void> {
    try {
      const models = await this.proc.call<{ models: OmoModelRecord[] }>("get_available_models", {}, 60_000);
      this.models = toProviderModels(models.models ?? []);
    } catch (error) {
      this.options.log(`get_available_models failed: ${describe(error)}`);
    }
    try {
      const commands = await this.proc.call<{ commands: OmoCommandRecord[] }>("get_commands", {}, 60_000);
      this.commands = (commands.commands ?? []).filter((command) => command.syntax !== "dollar");
    } catch (error) {
      this.options.log(`get_commands failed: ${describe(error)}`);
    }
  }

  private publishCommands(): void {
    this.emit({
      type: "session.commands",
      sessionId: this.sessionId,
      commands: this.commands.map((command) => ({
        name: command.name,
        description: command.description ?? `OmO ${command.name}`,
      })),
    });
  }

  configState(): ProviderConfigState {
    const settings: ProviderSetting[] = [
      { type: "toggle", id: "fastMode", label: "Priority tier", value: this.state.fastMode === true },
    ];
    const activeModel = this.state.model ? encodeModelId(this.state.model) : this.config.model;
    const known = this.models.some((model) => model.id === activeModel);
    const models =
      activeModel && !known
        ? [...this.models, { id: activeModel, label: this.state.model?.name ?? activeModel }]
        : this.models;
    return {
      ...(activeModel ? { model: activeModel } : {}),
      mode: this.config.mode ?? "default",
      ...(this.state.thinkingLevel ? { thinkingOption: this.state.thinkingLevel } : {}),
      models,
      modes: OMO_MODES.map((mode) => ({ ...mode })),
      thinkingOptions: allThinkingOptions(models),
      settings,
    };
  }

  /** Rebuild the visible conversation from OmO's own message log. */
  private async replay(): Promise<void> {
    let messages: unknown;
    try {
      const data = await this.proc.call<{ messages?: unknown }>("get_messages", {}, 60_000);
      messages = data?.messages ?? data;
    } catch (error) {
      this.options.log(`replay skipped: ${describe(error)}`);
      return;
    }
    if (!Array.isArray(messages)) return;
    let index = 0;
    for (const raw of messages) {
      index += 1;
      if (typeof raw !== "object" || raw === null) continue;
      const message = raw as Json;
      const role = message.role;
      if (message.display === false) continue;
      const text = messageText(message.content);
      if (role === "user" && text) {
        this.publishVisibleText("user", `replay-user-${index}`, text);
        continue;
      }
      if (role !== "assistant") continue;
      if (text) this.publishVisibleText("assistant", `replay-assistant-${index}`, text);
      for (const call of messageToolCalls(message.content)) {
        this.item({
          type: "tool_call",
          id: `replay-tool-${call.id}`,
          callId: call.id,
          name: call.name,
          detail: toolCallDetail(call.name, call.arguments),
          status: "completed",
          error: null,
        });
      }
    }
  }

  // ---------------------------------------------------------------- prompting

  prompt(clientMessageId: string, text: string, images: Array<{ data: string; mimeType: string }>, steer: boolean): void {
    if (steer) {
      if (!this.activeTurnId) {
        this.emit({
          type: "session.prompt_result",
          sessionId: this.sessionId,
          clientMessageId,
          result: { type: "failed", error: { message: "There is no active OmO turn to steer" } },
        });
        return;
      }
      this.publishVisibleText("user", `user-steer-${clientMessageId}`, text, { clientMessageId });
      void this.proc
        .call("steer", { message: text, ...(images.length > 0 ? { images } : {}) })
        .catch((error: unknown) => this.reportPromptFailure(clientMessageId, error));
      this.emit({
        type: "session.prompt_result",
        sessionId: this.sessionId,
        clientMessageId,
        result: { type: "steer", turnId: this.activeTurnId },
      });
      return;
    }

    this.turnSeq += 1;
    const turnId = `turn-${this.turnSeq}`;
    this.activeTurnId = turnId;
    this.publishVisibleText("user", `user-${this.turnSeq}`, text, { clientMessageId });
    this.emit({ type: "session.prompt_result", sessionId: this.sessionId, clientMessageId, result: { type: "turn", turnId } });
    this.emit({ type: "session.turn", sessionId: this.sessionId, turnId, state: "started" });
    void this.proc
      .call("prompt", { message: text, ...(images.length > 0 ? { images } : {}) }, 24 * 60 * 60 * 1000)
      .catch((error: unknown) => {
        this.item({ type: "error", id: `error-${turnId}`, message: describe(error) });
        this.failTurn(turnId, describe(error));
      });
  }

  private reportPromptFailure(clientMessageId: string, error: unknown): void {
    this.item({ type: "error", id: `error-steer-${clientMessageId}`, message: describe(error) });
  }

  private failTurn(turnId: string, message: string): void {
    if (this.activeTurnId !== turnId) return;
    this.activeTurnId = null;
    this.emit({ type: "session.turn", sessionId: this.sessionId, turnId, state: "failed", error: { message } });
  }

  async interrupt(): Promise<void> {
    await this.proc.call("abort", {}, 30_000);
  }

  /** True while this session has no child process, i.e. between suspend and resume. */
  get isSuspended(): boolean {
    return this.suspended;
  }

  /**
   * Stop this session's OmO child and wait for it to let go of the session file.
   *
   * Everything the dead child was going to answer is settled first: an active
   * turn is aborted and reported canceled, and pending confirm/select/question
   * requests are resolved, because the process that would have received those
   * answers is about to be gone.
   *
   * Idempotent, so a caller suspending every session does not have to know which
   * ones it already stopped.
   */
  async suspend(): Promise<void> {
    if (this.closed || this.suspended) return;
    this.suspended = true;

    if (this.activeTurnId) {
      try {
        await this.interrupt();
      } catch (error) {
        this.options.log(`abort before suspend failed: ${describe(error)}`);
      }
    }

    this.flushAll();

    for (const permissionId of [...this.pendingUi.keys()]) {
      this.pendingUi.delete(permissionId);
      this.emit({ type: "session.permission_resolved", sessionId: this.sessionId, permissionId });
    }

    const turnId = this.activeTurnId;
    if (turnId) {
      this.activeTurnId = null;
      this.emit({ type: "session.turn", sessionId: this.sessionId, turnId, state: "canceled" });
    }

    this.proc.stop();
    await withTimeout(this.proc.whenExited, PROCESS_EXIT_GRACE_MS);
  }

  /**
   * Start a fresh child on the same session file and republish the session's
   * state, so the conversation continues where the suspended one stopped.
   */
  async resume(): Promise<void> {
    if (this.closed || !this.suspended) return;
    const sessionFile = this.durableSessionFile;
    this.proc = this.createProcess(sessionFile);
    this.suspended = false;
    this.proc.start();
    this.state = await this.proc.call<OmoStateRecord>("get_state", {}, 240_000);
    await this.refreshCatalog();
    this.emit({ type: "session.config", sessionId: this.sessionId, config: this.configState() });
    this.publishCommands();
    const persistence = this.persistence();
    if (persistence) this.emit({ type: "session.persistence", sessionId: this.sessionId, persistence });
  }

  async configure(changes: {
    model?: string | null;
    mode?: string | null;
    thinkingOption?: string | null;
    settings?: Readonly<Record<string, unknown>>;
  }): Promise<void> {
    if (changes.model) {
      const model = decodeModelId(changes.model);
      if (model) await this.proc.call("set_model", { provider: model.provider, modelId: model.modelId }, 60_000);
    }
    if (changes.thinkingOption) await this.proc.call("set_thinking_level", { level: changes.thinkingOption }, 60_000);
    if (changes.mode) this.config = { ...this.config, mode: changes.mode };
    const fast = changes.settings?.fastMode;
    if (typeof fast === "boolean") await this.proc.call("set_fast_mode", { enabled: fast }, 60_000);
    try {
      this.state = await this.proc.call<OmoStateRecord>("get_state", {}, 60_000);
    } catch (error) {
      this.options.log(`get_state after configure failed: ${describe(error)}`);
    }
    this.emit({ type: "session.config", sessionId: this.sessionId, config: this.configState() });
  }

  respondToUiRequest(permissionId: string, response: ApprovalResponse): void {
    const pending = this.pendingUi.get(permissionId);
    if (!pending) throw new Error(`Unknown pending OmO UI request: ${permissionId}`);

    let wireResponse: Record<string, unknown>;
    if (response.behavior === "deny") {
      wireResponse = { type: "extension_ui_response", id: permissionId, cancelled: true };
    } else if (pending.method === "confirm") {
      if ("action" in response || "answer" in response) {
        throw new Error(`Confirmation request ${permissionId} only accepts allow or deny`);
      }
      wireResponse = { type: "extension_ui_response", id: permissionId, confirmed: true };
    } else if (pending.method === "select") {
      if (!("action" in response)) throw new Error(`Selection request ${permissionId} requires an action`);
      const label = pending.optionByAction.get(response.action);
      if (label === undefined) throw new Error(`Unknown action for OmO UI request ${permissionId}: ${response.action}`);
      wireResponse = { type: "extension_ui_response", id: permissionId, value: label };
    } else if ("action" in response) {
      const label = pending.optionByAction.get(response.action);
      if (label === undefined) throw new Error(`Unknown action for OmO UI request ${permissionId}: ${response.action}`);
      const key = pending.questionKey ?? "answer";
      wireResponse = {
        type: "extension_ui_response",
        id: permissionId,
        answers: { [key]: { selected: [label] } },
      };
    } else if ("answer" in response) {
      const answer = response.answer.trim();
      if (!answer) throw new Error(`Question request ${permissionId} requires a non-empty answer`);
      const key = pending.questionKey ?? "answer";
      wireResponse = {
        type: "extension_ui_response",
        id: permissionId,
        answers: { [key]: { selected: [], text: answer } },
      };
    } else {
      throw new Error(`Question request ${permissionId} requires an action or answer`);
    }

    this.proc.notify(wireResponse);
    this.pendingUi.delete(permissionId);
    this.emit({ type: "session.permission_resolved", sessionId: this.sessionId, permissionId });
  }

  respondToPermission(permissionId: string, response: ProviderPermissionResponse): void {
    const pending = this.pendingUi.get(permissionId);
    this.pendingUi.delete(permissionId);
    if (!pending) return;
    if (response.behavior === "deny") {
      this.proc.notify({ type: "extension_ui_response", id: permissionId, cancelled: true });
    } else if (pending.method === "confirm") {
      this.proc.notify({ type: "extension_ui_response", id: permissionId, confirmed: true });
    } else {
      const label = response.selectedActionId ? pending.optionByAction.get(response.selectedActionId) : undefined;
      if (pending.method === "select") {
        this.proc.notify({ type: "extension_ui_response", id: permissionId, value: label ?? "" });
      } else {
        const key = pending.questionKey ?? "answer";
        this.proc.notify({
          type: "extension_ui_response",
          id: permissionId,
          answers: { [key]: { selected: label ? [label] : [] } },
        });
      }
    }
    this.emit({ type: "session.permission_resolved", sessionId: this.sessionId, permissionId });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unregisterSession();
    for (const timer of this.flushTimers.values()) clearTimeout(timer);
    this.flushTimers.clear();
    this.proc.stop();
  }

  // ------------------------------------------------------------------- events

  private handleEvent(event: OmoEvent): void {
    switch (event.type) {
      case "agent_start":
        if (!this.activeTurnId) {
          this.turnSeq += 1;
          this.activeTurnId = `turn-${this.turnSeq}`;
          this.emit({ type: "session.turn", sessionId: this.sessionId, turnId: this.activeTurnId, state: "started" });
        }
        return;
      case "agent_end":
        this.flushAll();
        this.completeTurn(event);
        return;
      case "agent_settled":
      case "agent_idle":
        this.flushAll();
        this.completeTurn(undefined);
        return;
      case "session_abort": {
        this.flushAll();
        const turnId = this.activeTurnId;
        if (!turnId) return;
        this.activeTurnId = null;
        this.emit({ type: "session.turn", sessionId: this.sessionId, turnId, state: "canceled" });
        return;
      }
      case "message_start":
        if (roleOf(event.message) === "assistant") {
          this.messageSeq += 1;
          this.textBuffers.clear();
        }
        return;
      case "message_update":
        this.handleStream(event.assistantMessageEvent);
        return;
      case "message_end":
        this.handleMessageEnd(event.message);
        return;
      case "tool_execution_start":
      case "tool_execution_update":
      case "tool_execution_end":
        this.handleTool(event);
        return;
      case "extension_ui_request":
        this.handleUiRequest(event);
        return;
      case "model_changed":
      case "thinking_level_changed":
        this.handleConfigChanged(event);
        return;
      case "continuation_error":
        this.item({
          type: "error",
          id: `continuation-${this.turnSeq}-${this.messageSeq}`,
          message: typeof event.errorMessage === "string" ? event.errorMessage : "OmO continuation error",
        });
        return;
      default:
        return;
    }
  }

  private completeTurn(event: OmoEvent | undefined): void {
    // One card per turn, in the state the turn finished in: each publication is
    // its own timeline row, and the composer already counts the live progress.
    const finalTodo = finalTodoPublication(this.lastTodoSignature, this.pendingTodoItems);
    this.pendingTodoItems = undefined;
    if (finalTodo.publish && finalTodo.items !== undefined) {
      this.lastTodoSignature = finalTodo.signature;
      this.item({ type: "todo", id: this.todoItemId, items: finalTodo.items });
    }

    const turnId = this.activeTurnId;
    if (!turnId) return;
    this.activeTurnId = null;
    if (event && event.willRetry === true) {
      this.activeTurnId = turnId;
      return;
    }
    this.emit({ type: "session.turn", sessionId: this.sessionId, turnId, state: "completed" });
    const usage = usageOf(event);
    if (usage) this.emit({ type: "session.usage", sessionId: this.sessionId, turnId, usage });
    const persistence = this.persistence();
    if (persistence) this.emit({ type: "session.persistence", sessionId: this.sessionId, persistence });
  }

  private handleConfigChanged(event: OmoEvent): void {
    if (event.type === "model_changed" && typeof event.model === "object" && event.model !== null) {
      const model = event.model as Json;
      if (typeof model.id === "string" && typeof model.provider === "string") {
        this.state = {
          ...this.state,
          model: {
            id: model.id,
            provider: model.provider,
            ...(typeof model.name === "string" ? { name: model.name } : {}),
          },
        };
      }
    }
    if (typeof event.level === "string") this.state = { ...this.state, thinkingLevel: event.level };
    if (typeof event.thinkingLevel === "string") this.state = { ...this.state, thinkingLevel: event.thinkingLevel };
    this.emit({ type: "session.config", sessionId: this.sessionId, config: this.configState() });
  }

  private streamItemId(kind: "assistant" | "reasoning", contentIndex: number): string {
    return `${kind}-${this.turnSeq}-${this.messageSeq}-${contentIndex}`;
  }

  private handleStream(raw: unknown): void {
    if (typeof raw !== "object" || raw === null) return;
    const event = raw as Json;
    const contentIndex = typeof event.contentIndex === "number" ? event.contentIndex : 0;
    switch (event.type) {
      case "text_start":
        this.textBuffers.set(this.streamItemId("assistant", contentIndex), "");
        return;
      case "text_delta": {
        const id = this.streamItemId("assistant", contentIndex);
        const next = (this.textBuffers.get(id) ?? "") + String(event.delta ?? "");
        this.textBuffers.set(id, next);
        this.scheduleFlush(id, "assistant");
        return;
      }
      case "text_end": {
        const id = this.streamItemId("assistant", contentIndex);
        this.textBuffers.set(id, String(event.content ?? this.textBuffers.get(id) ?? ""));
        this.flush(id, "assistant");
        return;
      }
      case "thinking_start":
        this.textBuffers.set(this.streamItemId("reasoning", contentIndex), "");
        return;
      case "thinking_delta": {
        const id = this.streamItemId("reasoning", contentIndex);
        const next = (this.textBuffers.get(id) ?? "") + String(event.delta ?? "");
        this.textBuffers.set(id, next);
        this.scheduleFlush(id, "reasoning");
        return;
      }
      case "thinking_end": {
        const id = this.streamItemId("reasoning", contentIndex);
        this.textBuffers.set(id, String(event.content ?? this.textBuffers.get(id) ?? ""));
        this.flush(id, "reasoning");
        return;
      }
      case "error": {
        const message = messageText((event.error as Json | undefined)?.content) ?? "OmO stream error";
        this.item({ type: "error", id: `stream-error-${this.turnSeq}-${this.messageSeq}`, message });
        return;
      }
      default:
        return;
    }
  }

  private scheduleFlush(id: string, kind: "assistant" | "reasoning"): void {
    if (this.flushTimers.has(id)) return;
    const timer = setTimeout(() => {
      this.flushTimers.delete(id);
      this.flush(id, kind);
    }, STREAM_FLUSH_MS);
    this.flushTimers.set(id, timer);
  }

  private flush(id: string, kind: "assistant" | "reasoning"): void {
    const timer = this.flushTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.flushTimers.delete(id);
    }
    const text = this.textBuffers.get(id);
    if (text === undefined || text === "") return;
    if (kind === "reasoning") {
      this.item({ type: "reasoning", id, text });
      return;
    }
    this.publishVisibleText("assistant", id, text);
  }

  private flushAll(): void {
    for (const id of [...this.textBuffers.keys()]) {
      this.flush(id, id.startsWith("reasoning-") ? "reasoning" : "assistant");
    }
  }

  /**
   * Publish the final text under each text block's real content index.
   *
   * contentIndex in OmO stream events indexes the message content array
   * (thinking and toolCall blocks included), so a streamed text block that
   * follows thinking lives at index 1, not 0. Publishing the final snapshot
   * under a hardcoded 0 created a second timeline item with a different id —
   * the visible duplicate answer. Blocks that streamed already own their
   * buffer id, so this only refreshes that id's snapshot; unstreamed text
   * (string content, silent providers) falls back to index 0.
   */
  private handleMessageEnd(raw: unknown): void {
    if (roleOf(raw) !== "assistant") return;
    const message = raw as Json;
    const content = message.content;
    if (Array.isArray(content)) {
      let published = false;
      for (let index = 0; index < content.length; index += 1) {
        const part = content[index];
        if (typeof part !== "object" || part === null) continue;
        const text = (part as Json).text;
        if (typeof text !== "string" || !text.trim()) continue;
        const id = this.streamItemId("assistant", index);
        this.textBuffers.set(id, text);
        this.flush(id, "assistant");
        published = true;
      }
      if (published) return;
    }
    const text = messageText(content);
    if (!text) return;
    const id = this.streamItemId("assistant", 0);
    this.textBuffers.set(id, text);
    this.flush(id, "assistant");
  }

  private handleTool(event: OmoEvent): void {
    const callId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
    const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
    if (!callId) return;
    const known = this.toolCalls.get(callId);
    const args = event.args !== undefined ? event.args : known?.args;
    this.toolCalls.set(callId, { name: toolName, args });

    if (toolName === "todo") {
      // The arguments only carry the list as it was submitted; every status the
      // turn moves through lives in the RESULT, so a card built from arguments
      // alone can never show a task as done.
      const items = todoItems(args, event.result);
      if (items) {
        // Paseo appends every published item as its own timeline row, even under
        // a stable id, so each publication is another card in the chat. Only a
        // list that actually READS differently earns one: the start event's
        // all-pending snapshot of a list that is about to be updated, and a
        // result that repeats the previous state, are the repeated cards the
        // user was looking at.
        this.pendingTodoItems = holdTodo(items).items;
        if (event.type !== "tool_execution_end") return;
      }
    }

    const id = `tool-${callId}`;
    if (event.type === "tool_execution_end") {
      const output = toolResultText(event.result);
      const failed = event.isError === true;
      this.item({
        type: "tool_call",
        id,
        callId,
        name: toolName,
        detail: toolCallDetail(toolName, args, output),
        ...(failed
          ? { status: "failed" as const, error: (output ?? "Tool call failed") as string }
          : { status: "completed" as const, error: null }),
      });
      this.toolCalls.delete(callId);
      return;
    }
    const partial = event.type === "tool_execution_update" ? toolResultText(event.partialResult) : undefined;
    this.item({
      type: "tool_call",
      id,
      callId,
      name: toolName,
      detail: toolCallDetail(toolName, args, partial),
      status: "running",
      error: null,
    });
  }

  private handleUiRequest(event: OmoEvent): void {
    const id = typeof event.id === "string" ? event.id : undefined;
    const method = typeof event.method === "string" ? event.method : "";
    if (!id) return;

    if (method === "notify") {
      const severity = event.notifyType === "error" ? "error" : event.notifyType === "warning" ? "warning" : "info";
      this.emit({
        type: "session.notice",
        sessionId: this.sessionId,
        notice: { id, severity, title: String(event.message ?? "OmO notice") },
      });
      return;
    }
    if (method === "confirm") {
      const title = String(event.title ?? "OmO needs confirmation");
      this.pendingUi.set(id, { method: "confirm", title, optionByAction: new Map() });
      this.emit({
        type: "session.permission",
        sessionId: this.sessionId,
        request: {
          id,
          name: "confirm",
          kind: "other",
          title,
          description: String(event.message ?? ""),
          actions: [
            { id: "allow", label: "Yes", behavior: "allow", variant: "primary" },
            { id: "deny", label: "No", behavior: "deny" },
          ],
        },
      });
      return;
    }
    if (method === "select") {
      const options = Array.isArray(event.options) ? event.options.filter((o): o is string => typeof o === "string") : [];
      const optionByAction = new Map<string, string>();
      const actions = options.slice(0, 8).map((label, index) => {
        const actionId = `option-${index}`;
        optionByAction.set(actionId, label);
        return { id: actionId, label, behavior: "allow" as const };
      });
      const title = String(event.title ?? "OmO needs a choice");
      this.pendingUi.set(id, { method: "select", title, optionByAction });
      this.emit({
        type: "session.permission",
        sessionId: this.sessionId,
        request: {
          id,
          name: "select",
          kind: "question",
          title,
          actions: [...actions, { id: "deny", label: "Cancel", behavior: "deny" as const }],
        },
      });
      return;
    }
    if (method === "question") {
      const questions = Array.isArray(event.questions) ? event.questions : [];
      const first = questions.find((q): q is Json => typeof q === "object" && q !== null);
      if (!first) {
        this.proc.notify({ type: "extension_ui_response", id, cancelled: true });
        return;
      }
      const rawOptions = Array.isArray(first.options) ? first.options : [];
      const optionByAction = new Map<string, string>();
      const actions = rawOptions.slice(0, 8).flatMap((option, index) => {
        if (typeof option !== "object" || option === null) return [];
        const label = (option as Json).label;
        if (typeof label !== "string") return [];
        const actionId = `option-${index}`;
        optionByAction.set(actionId, label);
        return [{ id: actionId, label, behavior: "allow" as const }];
      });
      const title = String(first.question ?? first.header ?? "OmO has a question");
      this.pendingUi.set(id, {
        method: "question",
        title,
        optionByAction,
        ...(typeof first.id === "string" ? { questionKey: first.id } : {}),
      });
      this.emit({
        type: "session.permission",
        sessionId: this.sessionId,
        request: {
          id,
          name: "question",
          kind: "question",
          title: String(first.header ?? "OmO has a question"),
          description: String(first.question ?? ""),
          actions: [...actions, { id: "deny", label: "Skip", behavior: "deny" as const }],
        },
      });
      return;
    }
    if (method === "input" || method === "editor") {
      // Paseo's permission surface has no free-text field; let OmO fall back.
      this.proc.notify({ type: "extension_ui_response", id, cancelled: true });
      this.emit({
        type: "session.notice",
        sessionId: this.sessionId,
        notice: {
          id,
          severity: "info",
          title: String(event.title ?? "OmO asked for text input"),
          description: "Free-text prompts are not supported in Paseo yet; OmO continued without an answer.",
        },
      });
    }
  }
}

function roleOf(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const role = (message as Json).role;
  return typeof role === "string" ? role : undefined;
}

/** OmO message content is a string or an array of typed parts. */
export function messageText(content: unknown): string | undefined {
  if (typeof content === "string") return content.trim() ? content : undefined;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    const value = part as Json;
    if (value.type === "text" && typeof value.text === "string") parts.push(value.text);
  }
  const text = parts.join("\n").trim();
  return text ? text : undefined;
}

function messageToolCalls(content: unknown): Array<{ id: string; name: string; arguments: unknown }> {
  if (!Array.isArray(content)) return [];
  const calls: Array<{ id: string; name: string; arguments: unknown }> = [];
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    const value = part as Json;
    if (value.type !== "toolCall") continue;
    if (typeof value.id !== "string" || typeof value.name !== "string") continue;
    calls.push({ id: value.id, name: value.name, arguments: value.arguments });
  }
  return calls;
}

function usageOf(event: OmoEvent | undefined): { inputTokens?: number; outputTokens?: number } | undefined {
  if (!event) return undefined;
  const messages = event.messages;
  if (!Array.isArray(messages)) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (typeof message !== "object" || message === null) continue;
    const usage = (message as Json).usage;
    if (typeof usage !== "object" || usage === null) continue;
    const value = usage as Json;
    const input = typeof value.input === "number" ? value.input : undefined;
    const output = typeof value.output === "number" ? value.output : undefined;
    if (input === undefined && output === undefined) continue;
    return {
      ...(input !== undefined ? { inputTokens: input } : {}),
      ...(output !== undefined ? { outputTokens: output } : {}),
    };
  }
  return undefined;
}

export function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : JSON.stringify(error);
}
