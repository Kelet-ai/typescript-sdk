/**
 * Unit tests for the slim ``kelet.reasoning`` observer.
 */

import { describe, expect, test, beforeEach, mock } from 'bun:test';
import {
  observeAssistantMessage,
  REASONING_EVENT_NAME,
} from './streamObserver';
import {
  installReasoningObserver,
  type ClaudeAgentSDKModule,
} from './index';

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
    const fakeLogger = { emit: loggerEmit };
    // Replace the global logger provider so getLogger(...) returns our fake.
    // ``setGlobalLoggerProvider`` is a one-time setter — a second call silently
    // no-ops — so we ``disable()`` first to clear the previous global.
    const { logs: logsApi } = require('@opentelemetry/api-logs');
    logsApi.disable();
    logsApi.setGlobalLoggerProvider({
      getLogger: () => fakeLogger,
    });
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
    const { logs: logsApi } = require('@opentelemetry/api-logs');
    logsApi.disable();
    logsApi.setGlobalLoggerProvider({
      getLogger: () => ({ emit: loggerEmit }),
    });

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
});
