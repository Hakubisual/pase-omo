import type { PluginClientContext } from "@getpaseo/plugin/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { PendingApprovalRequest } from "../shared/approval.js";
import { approvalPillLabel, contributeApprovalPill } from "./approval-pill.js";

/**
 * The pill is the only always-visible entry point to a pending OmO request, so
 * these tests pin that it exists for every OmO agent whether or not anything is
 * waiting, that its label follows the pending count, and that a refresh which
 * throws keeps the label it already published instead of claiming the request
 * went away.
 */

const request = (id: string): PendingApprovalRequest => ({
  id,
  method: "question",
  title: "지금 진행할까요?",
  options: [],
});

let requests: PendingApprovalRequest[];
let rpcCalls: number;
let rpcFails: boolean;
let unsubscribed: number;
let labels: string[];
let removed: number;
let notify: () => void;

function stubClient(): PluginClientContext {
  const agents = [
    { id: "agent-1", provider: "omo", workspaceId: "wks-1" },
    { id: "agent-2", provider: "claude", workspaceId: "wks-1" },
  ];
  return {
    addComposerPill: ({ button }: { button: { label?: string } }) => {
      labels.push(button.label ?? "");
      return {
        update: (patch: { label?: string }) => {
          if (patch.label !== undefined) labels.push(patch.label);
        },
        remove: () => {
          removed += 1;
        },
      };
    },
    rpc: async () => {
      rpcCalls += 1;
      if (rpcFails) throw new Error("approval registry unreachable");
      return { requests };
    },
    paseo: {
      agents: {
        list: async () => ({ entries: agents.map((agent) => ({ agent })) }),
        subscribe: (listener: () => void) => {
          notify = listener;
          return () => {
            unsubscribed += 1;
          };
        },
      },
    },
  } as unknown as PluginClientContext;
}

beforeEach(() => {
  vi.useFakeTimers();
  requests = [];
  rpcCalls = 0;
  rpcFails = false;
  unsubscribed = 0;
  labels = [];
  removed = 0;
  notify = () => {};
});

afterEach(() => {
  vi.useRealTimers();
});

it("labels the idle state, the single request and the queue", () => {
  expect(approvalPillLabel(0)).toBe("승인");
  expect(approvalPillLabel(1)).toBe("응답 필요");
  expect(approvalPillLabel(3)).toBe("응답 필요 3");
});

it("registers one pill per OmO agent and follows the pending count", async () => {
  const dispose = contributeApprovalPill(stubClient());
  await vi.advanceTimersByTimeAsync(0);

  // Registered for the OmO agent only, and visible before anything is pending.
  expect(rpcCalls).toBe(1);
  expect(labels).toEqual(["승인", "승인"]);

  requests = [request("req-1")];
  notify();
  await vi.advanceTimersByTimeAsync(250);
  expect(labels.at(-1)).toBe("응답 필요");

  dispose();
  expect(removed).toBe(1);
  expect(unsubscribed).toBe(1);
});

it("keeps the published label when a refresh fails", async () => {
  const failures = vi.spyOn(console, "error").mockImplementation(() => {});
  const dispose = contributeApprovalPill(stubClient());
  requests = [request("req-1")];
  await vi.advanceTimersByTimeAsync(0);
  expect(labels.at(-1)).toBe("응답 필요");

  rpcFails = true;
  notify();
  await vi.advanceTimersByTimeAsync(250);
  expect(labels.at(-1)).toBe("응답 필요");
  expect(failures).toHaveBeenCalledOnce();

  dispose();
  failures.mockRestore();
});

it("does no periodic work while nothing changes", async () => {
  const dispose = contributeApprovalPill(stubClient());
  await vi.advanceTimersByTimeAsync(0);
  expect(rpcCalls).toBe(1);

  await vi.advanceTimersByTimeAsync(30_000);
  expect(rpcCalls).toBe(1);

  dispose();
  notify();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(rpcCalls).toBe(1);
});
