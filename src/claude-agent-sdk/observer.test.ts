/**
 * Unit tests for the slim ``kelet.reasoning`` observer.
 */

import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test';
import {
  observeAssistantMessage,
  REASONING_EVENT_NAME,
} from './streamObserver';
import {
  installReasoningObserver,
  REASONING_SCOPE_NAME,
  setReasoningLogger,
  type ClaudeAgentSDKModule,
} from './index';
// Top-level ESM import (not ``require()``) so this suite runs under
// strict Node --experimental-vm-modules / tsx as well as Bun.
import {
  logs as logsApi,
  type Logger,
  type LoggerProvider as LoggerProviderApi,
} from '@opentelemetry/api-logs';

describe('observeAssistantMessage', () => {
  test('emits one attribute set per ThinkingBlock on a Py-shape message', () => {
    const emits: Record<string, string>[] = [];
    observeAssistantMessage(
      {
        type: 'assistant',
        content: [
          { thinking: 'thought-a', signature: 'sig-a' },
          { text: 'regular text block' },
          { thinking: 'thought-b' },
        ],
        message_id: 'msg_1',
        session_id: 'sess_1',
      },
      (attrs) => emits.push(attrs),
    );

    expect(emits).toHaveLength(2);
    expect(emits[0]).toEqual({
      'reasoning.text': 'thought-a',
      'reasoning.signature': 'sig-a',
      'reasoning.message_id': 'msg_1',
      'session.id': 'sess_1',
    });
    expect(emits[1]).toEqual({
      'reasoning.text': 'thought-b',
      'reasoning.signature': '',
      'reasoning.message_id': 'msg_1',
      'session.id': 'sess_1',
    });
  });

  test('reads TS-shape message.content[] + message.id', () => {
    const emits: Record<string, string>[] = [];
    observeAssistantMessage(
      {
        type: 'assistant',
        message: {
          id: 'msg_2',
          content: [{ thinking: 'thought-ts' }],
        },
      },
      (attrs) => emits.push(attrs),
    );

    expect(emits).toHaveLength(1);
    expect(emits[0]!['reasoning.text']).toBe('thought-ts');
    expect(emits[0]!['reasoning.message_id']).toBe('msg_2');
  });

  test('omits reasoning.message_id when message carries no id', () => {
    const emits: Record<string, string>[] = [];
    observeAssistantMessage(
      { content: [{ thinking: 't' }] },
      (attrs) => emits.push(attrs),
    );
    expect(emits).toHaveLength(1);
    expect(emits[0]).not.toHaveProperty('reasoning.message_id');
    expect(emits[0]).not.toHaveProperty('session.id');
  });

  test('no-ops for non-assistant shapes', () => {
    const emits: Record<string, string>[] = [];
    observeAssistantMessage(null, (attrs) => emits.push(attrs));
    observeAssistantMessage('string', (attrs) => emits.push(attrs));
    observeAssistantMessage({}, (attrs) => emits.push(attrs));
    observeAssistantMessage({ content: 'not a list' }, (attrs) => emits.push(attrs));
    expect(emits).toHaveLength(0);
  });
});

describe('installReasoningObserver', () => {
  function makeSdk(
    messages: unknown[],
    options: { withClient?: boolean } = {},
  ): ClaudeAgentSDKModule {
    const query = mock(() => {
      async function* gen() {
        for (const m of messages) yield m;
      }
      return gen() as AsyncGenerator<unknown> & Record<string, unknown>;
    });

    const sdk: ClaudeAgentSDKModule = { query } as unknown as ClaudeAgentSDKModule;

    if (options.withClient) {
      class FakeClient {
        query(..._args: unknown[]): AsyncIterable<unknown> {
          async function* gen() {
            for (const m of messages) yield m;
          }
          return gen();
        }
        receiveMessages(..._args: unknown[]): AsyncIterable<unknown> {
          async function* gen() {
            for (const m of messages) yield m;
          }
          return gen();
        }
        receiveResponse(..._args: unknown[]): AsyncIterable<unknown> {
          async function* gen() {
            for (const m of messages) yield m;
          }
          return gen();
        }
      }
      sdk.ClaudeSDKClient = FakeClient as unknown as ClaudeAgentSDKModule['ClaudeSDKClient'];
    }

    return sdk;
  }

  function capturedAttrs(loggerEmit: ReturnType<typeof mock>): Record<string, unknown>[] {
    return (loggerEmit.mock.calls as unknown as unknown[][])
      .map((call) => (call[0] as { attributes?: Record<string, unknown> })?.attributes)
      .filter((a): a is Record<string, unknown> => !!a);
  }

  let loggerEmit: ReturnType<typeof mock>;

  beforeEach(() => {
    loggerEmit = mock(() => {});
    const fakeLogger = { emit: loggerEmit } as unknown as Logger;
    // Route emissions through the integration-scoped logger override
    // rather than clobbering the OTel global LoggerProvider. That
    // matches production wiring (``configure()`` calls
    // ``setReasoningLogger(provider.getLogger(...))``) and keeps the
    // global slot clean so host apps aren't affected by test state.
    setReasoningLogger(fakeLogger);
  });

  afterEach(() => {
    // Clear the override so other suites fall back to the OTel default.
    setReasoningLogger(null);
  });

  test('query() wrapper yields all messages + emits for ThinkingBlocks', async () => {
    const sdk = makeSdk([
      { type: 'assistant', content: [{ thinking: 'a' }] },
      { type: 'assistant', content: [{ text: 't' }] },
      { type: 'assistant', content: [{ thinking: 'b' }] },
    ]);

    installReasoningObserver(sdk);

    const received: unknown[] = [];
    for await (const msg of sdk.query({ prompt: 'go' })) {
      received.push(msg);
    }

    expect(received).toHaveLength(3);
    expect(loggerEmit).toHaveBeenCalledTimes(2);

    const attrs = capturedAttrs(loggerEmit);
    expect(attrs[0]!['reasoning.text']).toBe('a');
    expect(attrs[1]!['reasoning.text']).toBe('b');
    expect(attrs[0]!['event.name']).toBe(REASONING_EVENT_NAME);
  });

  test('second install is a no-op (sentinel short-circuits)', () => {
    const sdk = makeSdk([]);
    const originalQuery = sdk.query;
    installReasoningObserver(sdk);
    const firstWrapped = sdk.query;
    installReasoningObserver(sdk);
    expect(sdk.query).toBe(firstWrapped);
    expect(sdk.query).not.toBe(originalQuery);
  });

  test('ClaudeSDKClient.query/receiveMessages/receiveResponse wrapped when present', async () => {
    const messages = [{ type: 'assistant', content: [{ thinking: 'client-thought' }] }];
    const sdk = makeSdk(messages, { withClient: true });
    installReasoningObserver(sdk);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = new (sdk.ClaudeSDKClient as unknown as new () => any)();

    const drained: unknown[] = [];
    for await (const m of client.query('prompt') as AsyncIterable<unknown>) {
      drained.push(m);
    }
    expect(drained).toEqual(messages);
    expect(loggerEmit).toHaveBeenCalledTimes(1);

    loggerEmit.mockClear();
    const drained2: unknown[] = [];
    for await (const m of client.receiveMessages() as AsyncIterable<unknown>) {
      drained2.push(m);
    }
    expect(drained2).toEqual(messages);
    expect(loggerEmit).toHaveBeenCalledTimes(1);

    loggerEmit.mockClear();
    const drained3: unknown[] = [];
    for await (const m of client.receiveResponse() as AsyncIterable<unknown>) {
      drained3.push(m);
    }
    expect(drained3).toEqual(messages);
    expect(loggerEmit).toHaveBeenCalledTimes(1);
  });

  test('observer failures do not break user iteration', async () => {
    loggerEmit = mock(() => {
      throw new Error('exporter down');
    });
    setReasoningLogger({ emit: loggerEmit } as unknown as Logger);

    const sdk = makeSdk([
      { type: 'assistant', content: [{ thinking: 'x' }] },
    ]);
    installReasoningObserver(sdk);

    const received: unknown[] = [];
    for await (const msg of sdk.query({ prompt: 'go' })) {
      received.push(msg);
    }
    expect(received).toHaveLength(1);
  });

  // ----- Finality gate: do not emit on partial/stream-delta messages ------

  test('skips emission when msg.type is not "assistant"', async () => {
    const sdk = makeSdk([
      // Partial/delta types the CC SDK may yield while the final
      // AssistantMessage is being assembled:
      { type: 'partial_assistant', content: [{ thinking: 'streaming' }] },
      { type: 'stream_event', content: [{ thinking: 'early' }] },
      // Final consolidated assistant message — only this should emit.
      {
        type: 'assistant',
        content: [{ thinking: 'final' }],
        message_id: 'msg_1',
      },
    ]);
    installReasoningObserver(sdk);

    const drained: unknown[] = [];
    for await (const msg of sdk.query({ prompt: 'p' })) {
      drained.push(msg);
    }
    expect(drained).toHaveLength(3);
    expect(loggerEmit).toHaveBeenCalledTimes(1);
    const [attrs] = capturedAttrs(loggerEmit);
    expect(attrs?.['reasoning.text']).toBe('final');
  });

  test('messages without a type field still emit (back-compat)', async () => {
    // Older SDK shapes that only yield finalized envelopes (no type
    // discriminator). We can't know whether they're partial so the
    // observer defaults to "emit". The CC contract expected this.
    const sdk = makeSdk([{ content: [{ thinking: 'no-type' }] }]);
    installReasoningObserver(sdk);
    for await (const _ of sdk.query({ prompt: 'p' })) {
      // drain
    }
    expect(loggerEmit).toHaveBeenCalledTimes(1);
  });

  // ----- Sticky session_id across stream ---------------------------------

  test('sticks session.id forward when a later msg drops it', async () => {
    const sdk = makeSdk([
      {
        type: 'assistant',
        content: [{ thinking: 'first' }],
        session_id: 'sticky-sess',
        message_id: 'm1',
      },
      // Second message has no session_id on the envelope; extractor
      // would drop it if we didn't carry the sticky id forward.
      {
        type: 'assistant',
        content: [{ thinking: 'second' }],
        message_id: 'm2',
      },
    ]);
    installReasoningObserver(sdk);
    for await (const _ of sdk.query({ prompt: 'p' })) {
      // drain
    }
    const attrs = capturedAttrs(loggerEmit);
    expect(attrs[0]?.['session.id']).toBe('sticky-sess');
    expect(attrs[1]?.['session.id']).toBe('sticky-sess');
  });

  // ----- Rest-args forwarding (TS reviewer #2) ---------------------------

  test('query() wrapper forwards all positional args to the original', async () => {
    const seen: unknown[][] = [];
    const sdk: ClaudeAgentSDKModule = {
      query: (...passthrough: unknown[]): AsyncIterable<unknown> & Record<string, unknown> => {
        seen.push(passthrough);
        const stream = (async function* () {
          yield { type: 'assistant', content: [] };
        })() as unknown as AsyncIterable<unknown> & Record<string, unknown>;
        return stream;
      },
    };
    installReasoningObserver(sdk);

    // Call with two args — the wrapper must forward both, not just args[0].
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ret = (sdk.query as any)({ prompt: 'p' }, { extra: 'flag' });
    for await (const _ of ret as AsyncIterable<unknown>) {
      // drain
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual([{ prompt: 'p' }, { extra: 'flag' }]);
  });
});

// ---------------------------------------------------------------------------
// Scope name + non-clobber contracts
// ---------------------------------------------------------------------------

describe('integration-scoped logger', () => {
  test('REASONING_SCOPE_NAME starts with com.anthropic.claude_code', () => {
    // Server-side /api/logs filter rejects records whose scope.name
    // doesn't start with this prefix. Regression guard for PR #10 review
    // Critical-equivalent in Python SDK PR #9.
    expect(REASONING_SCOPE_NAME.startsWith('com.anthropic.claude_code')).toBe(true);
  });

  test('setReasoningLogger overrides global resolution, reset restores it', async () => {
    const sentinel = { emit: mock(() => {}) } as unknown as Logger;
    setReasoningLogger(sentinel);

    const sdk: ClaudeAgentSDKModule = {
      query: (): AsyncIterable<unknown> & Record<string, unknown> => {
        const stream = (async function* () {
          yield { type: 'assistant', content: [{ thinking: 't' }] };
        })() as unknown as AsyncIterable<unknown> & Record<string, unknown>;
        return stream;
      },
    };
    installReasoningObserver(sdk);
    for await (const _ of sdk.query({ prompt: 'p' })) {
      // drain — should route through ``sentinel``
    }
    expect((sentinel as unknown as { emit: ReturnType<typeof mock> }).emit).toHaveBeenCalledTimes(1);

    // Clear the override and ensure global fallback kicks in next time.
    setReasoningLogger(null);
    // No assertions on the fallback (no global provider wired here) —
    // we're only asserting the override plumbing resets cleanly.
  });

  test('setReasoningLogger does NOT touch the OTel global LoggerProvider', () => {
    const before = logsApi.getLoggerProvider() as LoggerProviderApi;
    const sentinel = { emit: mock(() => {}) } as unknown as Logger;
    setReasoningLogger(sentinel);
    const after = logsApi.getLoggerProvider() as LoggerProviderApi;
    // The setter works on a module-local reference, not on the global.
    // Any host app logging pipeline stays intact.
    expect(after).toBe(before);
    setReasoningLogger(null);
  });
});
