import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import type { GoogleChatCoreRuntime, GoogleChatRuntimeEnv } from "./monitor-types.js";
import type { GoogleChatEvent } from "./types.js";
import "./monitor.js";

const apiMocks = vi.hoisted(() => ({
  deleteGoogleChatMessage: vi.fn(),
  downloadGoogleChatMedia: vi.fn(),
  sendGoogleChatMessage: vi.fn(),
  updateGoogleChatMessage: vi.fn(),
}));
const routingMocks = vi.hoisted(() => ({
  processEvent: undefined as
    | ((event: GoogleChatEvent, target: Record<string, unknown>) => Promise<void>)
    | undefined,
}));
vi.mock("./api.js", () => apiMocks);
vi.mock("./monitor-access.js", () => ({
  applyGoogleChatInboundAccessPolicy: vi.fn(async () => ({ ok: true })),
}));
vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>()),
  resolveChannelInboundRouteEnvelope: vi.fn(({ accountId }: { accountId: string }) => ({
    route: { agentId: "agent-1", accountId, sessionKey: "session-1" },
    buildEnvelope: ({ body }: { body: string }) => body,
  })),
}));
vi.mock("./monitor-routing.js", () => ({
  registerGoogleChatWebhookTarget: vi.fn(),
  setGoogleChatWebhookEventProcessor: (processEvent: typeof routingMocks.processEvent) => {
    routingMocks.processEvent = processEvent;
  },
}));
beforeEach(() => {
  apiMocks.deleteGoogleChatMessage.mockReset();
  apiMocks.sendGoogleChatMessage.mockReset();
  apiMocks.updateGoogleChatMessage.mockReset().mockResolvedValue({});
});

function createInboundClassificationHarness() {
  const buildContext = vi.fn((payload: unknown) => payload);
  const runTurn = vi.fn();
  const core = {
    logging: { shouldLogVerbose: () => false },
    channel: { inbound: { buildContext, run: runTurn } },
  } as unknown as GoogleChatCoreRuntime;
  return { core, buildContext, runTurn };
}

async function processGoogleChatTestEvent(params: {
  event: GoogleChatEvent;
  account: ResolvedGoogleChatAccount;
  config: Record<string, unknown>;
  runtime: GoogleChatRuntimeEnv;
  core: GoogleChatCoreRuntime;
  mediaMaxMb: number;
}) {
  if (!routingMocks.processEvent) {
    throw new Error("Expected Google Chat webhook event processor registration");
  }
  await routingMocks.processEvent(params.event, { ...params, path: "/googlechat" });
}
describe.each(["created", "disabled", "failed"])(
  "threaded replies with typing preview=%s",
  (preview) => {
    it.each([
      { mode: "all", target: undefined, expected: "root" },
      { mode: "all", target: "current", expected: "root" },
      { mode: "all", target: "other", expected: "other" },
      { mode: "all", target: "optout", expected: undefined },
      { mode: "first", target: undefined, expected: "root" },
      { mode: "first", target: "other", expected: "other" },
      { mode: "first", target: "optout", expected: undefined },
      { mode: "first", target: "status", expected: "root" },
      { mode: "off", target: undefined, expected: undefined },
      { mode: "off", target: "current", expected: "root" },
      { mode: undefined, target: undefined, expected: undefined },
    ] as const)("preserves mode=$mode target=$target", async ({ mode, target, expected }) => {
      const { core, runTurn, buildContext } = createInboundClassificationHarness();
      core.channel.text = {
        resolveChunkMode: vi.fn(() => "markdown"),
        chunkMarkdownTextWithMode: vi.fn((text: string) => [text]),
      } as unknown as GoogleChatCoreRuntime["channel"]["text"];
      const account: ResolvedGoogleChatAccount = {
        accountId: "work",
        enabled: true,
        credentialSource: "inline",
        config: {
          replyToMode: mode,
          typingIndicator: preview === "disabled" ? "none" : "message",
        },
      };
      const thread = "spaces/CLASSIFY/threads/root";
      const currentMessage = "spaces/CLASSIFY/messages/root.child";
      const typingThread = mode === "all" || mode === "first" ? thread : undefined;
      apiMocks.sendGoogleChatMessage.mockResolvedValue({
        messageName: "spaces/CLASSIFY/messages/typing",
        threadName: typingThread,
      });
      if (preview === "failed") {
        apiMocks.sendGoogleChatMessage.mockRejectedValueOnce(new Error("Typing unavailable"));
      }
      await processGoogleChatTestEvent({
        event: {
          type: "MESSAGE",
          space: { name: "spaces/CLASSIFY", spaceType: "SPACE" },
          message: {
            name: currentMessage,
            text: "hello",
            thread: { name: thread },
            sender: { name: "users/alice", type: "HUMAN" },
          },
        },
        account,
        config: {},
        runtime: { error: vi.fn(), log: vi.fn() },
        core,
        mediaMaxMb: 10,
      });
      const run = runTurn.mock.calls[0]?.[0] as {
        adapter: {
          resolveTurn: () => {
            delivery: {
              durable: (payload: ReplyPayload, info: { kind: string }) => unknown;
              deliver: (payload: ReplyPayload) => Promise<void>;
              onDelivered: (
                payload: ReplyPayload,
                info?: { kind: string },
                result?: { visibleReplySent?: boolean; suppression?: { reason: string } },
              ) => void;
            };
          };
        };
      };
      const delivery = run.adapter.resolveTurn().delivery;
      const expectedThread = expected ? `spaces/CLASSIFY/threads/${expected}` : undefined;
      const payload: ReplyPayload = {
        text: "Normal final answer",
        replyToId:
          target === "current" ? currentMessage : target === "other" ? expectedThread : undefined,
        replyToCurrent: target === "optout" ? false : undefined,
        isStatusNotice: target === "status" || undefined,
      };
      // Hooks may suppress an attempted reply before the actual answer arrives.
      delivery.onDelivered(payload, { kind: "final" }, { visibleReplySent: false });
      delivery.onDelivered(
        payload,
        { kind: "final" },
        { suppression: { reason: "channel_transform" } },
      );
      expect(delivery.durable(payload, { kind: "final" })).toEqual(
        preview === "created"
          ? false
          : expectedThread
            ? { to: "spaces/CLASSIFY", replyToId: expectedThread, threadId: expectedThread }
            : { to: "spaces/CLASSIFY", replyToId: null, threadId: null },
      );
      apiMocks.sendGoogleChatMessage.mockClear();
      await delivery.deliver(payload);
      if (preview === "created" && typingThread === expectedThread) {
        expect(apiMocks.updateGoogleChatMessage).toHaveBeenCalledWith({
          account,
          messageName: "spaces/CLASSIFY/messages/typing",
          text: payload.text,
        });
        expect(apiMocks.deleteGoogleChatMessage).not.toHaveBeenCalled();
        expect(apiMocks.sendGoogleChatMessage).not.toHaveBeenCalled();
      } else {
        expect(apiMocks.sendGoogleChatMessage).toHaveBeenCalledWith({
          account,
          space: "spaces/CLASSIFY",
          text: payload.text,
          thread: expectedThread,
        });
      }
      delivery.onDelivered(payload);
      const laterThread =
        mode === "all" || (mode === "first" && (!expectedThread || target === "status"))
          ? thread
          : undefined;
      expect(delivery.durable({ text: "Later answer" }, { kind: "final" })).toEqual(
        laterThread
          ? { to: "spaces/CLASSIFY", replyToId: laterThread, threadId: laterThread }
          : { to: "spaces/CLASSIFY", replyToId: null, threadId: null },
      );
      expect(buildContext).toHaveBeenCalledWith(
        expect.objectContaining({ reply: expect.objectContaining({ messageThreadId: thread }) }),
      );
    });
  },
);
