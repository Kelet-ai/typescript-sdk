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
export function observeAssistantMessage(
  msg: unknown,
  emit: EmitReasoning,
  stickySessionId?: string,
): string | undefined {
  if (typeof msg !== 'object' || msg === null) return undefined;

  const candidate = msg as AssistantMessageLike;

  // Finality gate: only emit for *finalized* assistant messages. The CC
  // SDK yields ``PartialAssistantMessage`` (type="partial_assistant") /
  // ``StreamEvent`` deltas before the consolidated ``AssistantMessage``.
  // Both shapes can carry a ``thinking`` string under ``content[]`` as
  // the stream accumulates — emitting on deltas would produce N
  // duplicate reasoning records keyed on the same ``reasoning.message_id``
  // which the server-side extractor would collapse via last-write-wins.
  //
  // The SDK sets ``type = 'assistant'`` on finalized envelopes. Any
  // other value (``'partial_assistant'``, ``'user'``, ``'system'``,
  // ``'result'``, etc.) is skipped. Messages without a ``type`` field
  // pass through for back-compat with older SDK shapes that only
  // yielded finalized envelopes.
  if (typeof candidate.type === 'string' && candidate.type !== 'assistant') {
    return stickySessionId;
  }

  const content = Array.isArray(candidate.content)
    ? candidate.content
    : Array.isArray(candidate.message?.content)
      ? (candidate.message as { content: unknown[] }).content
      : null;
  if (!content) return stickySessionId;

  // ``message_id`` is optional per contract — include it only when the
  // message actually carries one (matches the Python wrapper behaviour).
  // Py SDK exposes ``message_id`` on the AssistantMessage envelope;
  // TS SDK puts the Anthropic API id on ``message.id``.
  const messageId = candidate.message_id ?? candidate.message?.id;
  // ``session.id`` is required by the server's ``/api/logs`` router.
  // Early-stream messages can arrive before the SDK populates one on
  // the envelope, so we fall back to a sticky id remembered from an
  // earlier message in the same stream.
  const currentSessionId = candidate.session_id ?? candidate.sessionId;
  const sessionId = currentSessionId ?? stickySessionId;

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

  // Let callers thread an updated sticky id through the iteration.
  return currentSessionId ?? stickySessionId;
}
