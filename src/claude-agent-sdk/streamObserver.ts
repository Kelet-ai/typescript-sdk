/**
 * Stream observer: scan ``AssistantMessage.content[]`` for ``ThinkingBlock``
 * entries and invoke an ``emit`` callback with per-block attributes.
 *
 * Why we do this in-SDK rather than rely on native OTLP: Claude Code
 * redacts ``thinking`` text in its ``api_response_body`` log event
 * (``"thinking":"<REDACTED>"``). To preserve reasoning fidelity in the
 * extraction pipeline we observe the in-process message stream — which
 * surfaces the full ``ThinkingBlock`` content — and emit a
 * ``kelet.reasoning`` OTLP log record per block.
 *
 * The observer is duck-typed against the SDK's message shape: we accept
 * anything with ``content: unknown[]`` (Python-SDK shape) or
 * ``message.content: unknown[]`` (TypeScript-SDK shape) and look for blocks
 * that expose a string ``thinking`` field. This keeps the wrapper working
 * across minor SDK releases without an explicit import.
 *
 * @module claude-agent-sdk/streamObserver
 */

/** Event name mandated by the SDK contract. */
export const REASONING_EVENT_NAME = 'kelet.reasoning';

/** Duck-typed shape of a ``ThinkingBlock`` entry. */
interface ThinkingBlockLike {
  /** Full reasoning text (required for us to emit an event). */
  thinking: string;
  /** Opaque signature returned by the model; may be empty or absent. */
  signature?: string;
}

/** Duck-typed shape of an ``AssistantMessage``.
 *
 * The Python SDK places ``content`` directly on the message; the TypeScript
 * SDK v0.1.x wraps it under ``message.content`` (see ``SDKAssistantMessage``
 * in ``@anthropic-ai/claude-agent-sdk``). We accept both shapes.
 */
interface AssistantMessageLike {
  /** Discriminator set by the SDK on assistant messages. */
  type?: string;
  /** Python-SDK shape — content blocks directly on the message. */
  content?: unknown;
  /** TypeScript-SDK shape — ``message.content`` nested under the envelope. */
  message?: {
    content?: unknown;
    id?: string;
  };
  /** Anthropic message id, e.g. ``msg_abc...`` — optional per contract. */
  message_id?: string;
  /** Session id — surfaced on some SDK shapes; carried through when present. */
  session_id?: string;
  sessionId?: string;
}

function isThinkingBlock(value: unknown): value is ThinkingBlockLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { thinking?: unknown }).thinking === 'string'
  );
}

/** Callback invoked by {@link observeAssistantMessage} for each reasoning block. */
export type EmitReasoning = (attributes: Record<string, string>) => void;

/**
 * Invoke ``emit`` for every ``ThinkingBlock`` entry in ``msg``.
 *
 * No-ops silently for messages of other shapes (``UserMessage``,
 * ``ResultMessage``, ``SystemMessage``). Emit failures are the caller's
 * responsibility to catch.
 *
 * @param msg A streamed message from ``query()`` / ``ClaudeSDKClient``.
 * @param emit Callback invoked once per thinking block with the attribute
 *   map to attach to the emitted log record.
 */
export function observeAssistantMessage(msg: unknown, emit: EmitReasoning): void {
  if (typeof msg !== 'object' || msg === null) return;

  const candidate = msg as AssistantMessageLike;
  const content = Array.isArray(candidate.content)
    ? candidate.content
    : Array.isArray(candidate.message?.content)
      ? candidate.message!.content
      : null;
  if (!content) return;

  // ``message_id`` is optional per contract — include it only when the
  // message actually carries one (matches the Python wrapper behaviour).
  // Py SDK exposes ``message_id`` on the AssistantMessage envelope;
  // TS SDK puts the Anthropic API id on ``message.id``.
  const messageId = candidate.message_id ?? candidate.message?.id;
  const sessionId = candidate.session_id ?? candidate.sessionId;

  for (const block of content) {
    if (!isThinkingBlock(block)) continue;
    const attrs: Record<string, string> = {
      'reasoning.text': block.thinking,
      'reasoning.signature': block.signature ?? '',
    };
    if (messageId) attrs['reasoning.message_id'] = messageId;
    if (sessionId) attrs['session.id'] = sessionId;
    emit(attrs);
  }
}
