// Googlechat plugin module implements monitor durable behavior.
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";

type GoogleChatDurableReplyOptions = {
  to: string;
  replyToId?: string | null;
  threadId?: string | null;
};

export function resolveGoogleChatDurableReplyOptions(params: {
  payload: ReplyPayload;
  infoKind: string;
  spaceId: string;
  hasTypingMessage: boolean;
}): GoogleChatDurableReplyOptions | false {
  if (params.infoKind !== "final" || params.hasTypingMessage) {
    return false;
  }
  const threadId = params.payload.replyToId?.trim() || undefined;
  if (!threadId) {
    // Omission lets durable delivery inherit MessageThreadId from inbound context.
    return { to: params.spaceId, replyToId: null, threadId: null };
  }
  return {
    to: params.spaceId,
    replyToId: threadId,
    threadId,
  };
}
