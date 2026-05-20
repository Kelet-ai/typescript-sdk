import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  REASONING_EVENT_NAME,
  REASONING_SCOPE_NAME,
  resetInjectCcTelemetry,
  resetLogger,
  setInjectCcTelemetry,
  setLogger,
  wrapClaudeSDKClient,
  wrapQuery,
  type MinimalLogger,
} from './reasoningObserver';
import type { KeletConfig } from '../config';

const TEST_CONFIG: KeletConfig = {
  apiKey: 'test-key',
  project: 'test-project',
  apiUrl: 'http://localhost:5002',
};

class _CapturingLogger implements MinimalLogger {
  records: Array<{ body: string; attributes?: Record<string, unknown>; eventName?: string }> = [];
  emit(record: { body: string; attributes?: Record<string, unknown>; eventName?: string }): void {
    this.records.push(record);
  }
}

class _FakeClaudeAgentOptions {
  env?: Record<string, string>;
  // Other options keys can be set by callers — we only care about env here.
  [key: string]: unknown;
}

describe('REASONING_SCOPE_NAME / REASONING_EVENT_NAME', () => {
  test('scope name uses the com.anthropic.claude_code prefix the server filter requires', () => {
    expect(REASONING_SCOPE_NAME.startsWith('com.anthropic.claude_code')).toBe(true);
  });

  test('event name matches the Python contract', () => {
    expect(REASONING_EVENT_NAME).toBe('kelet.reasoning');
  });
});

describe('wrapQuery — env injection', () => {
  let capturedArgs: unknown[] = [];

  function _makeOriginalQuery() {
    return async function* (...args: unknown[]) {
      capturedArgs = args;
      // Yield nothing — we only care about the captured options.env here.
    };
  }

  beforeEach(() => {
    capturedArgs = [];
    resetInjectCcTelemetry();
    resetLogger();
  });

  afterEach(() => {
    resetInjectCcTelemetry();
    resetLogger();
  });

  test('injects seven keys when options is undefined', async () => {
    const wrapped = wrapQuery(_makeOriginalQuery(), () => TEST_CONFIG, _FakeClaudeAgentOptions);
    // Drain.
    for await (const _ of wrapped('prompt')) {
      void _;
    }
    const options = capturedArgs[1] as _FakeClaudeAgentOptions;
    expect(options).toBeDefined();
    expect(options.env).toBeDefined();
    expect(options.env!.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('1');
    expect(options.env!.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://localhost:5002');
  });

  test('preserves user-supplied options.env keys', async () => {
    const userOpts = new _FakeClaudeAgentOptions();
    userOpts.env = { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://user.example' };
    const wrapped = wrapQuery(_makeOriginalQuery(), () => TEST_CONFIG, _FakeClaudeAgentOptions);
    for await (const _ of wrapped('prompt', userOpts)) {
      void _;
    }
    expect(userOpts.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('https://user.example');
    // Other six injected.
    expect(userOpts.env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('1');
  });

  test('skip injection when injectCcTelemetry is false', async () => {
    setInjectCcTelemetry(false);
    const userOpts = new _FakeClaudeAgentOptions();
    userOpts.env = {};
    const wrapped = wrapQuery(_makeOriginalQuery(), () => TEST_CONFIG, _FakeClaudeAgentOptions);
    for await (const _ of wrapped('prompt', userOpts)) {
      void _;
    }
    expect(userOpts.env).toEqual({});
  });

  test('skip injection when configResolver returns null (Kelet not configured)', async () => {
    const userOpts = new _FakeClaudeAgentOptions();
    userOpts.env = { OTHER: 'value' };
    const wrapped = wrapQuery(_makeOriginalQuery(), () => null, _FakeClaudeAgentOptions);
    for await (const _ of wrapped('prompt', userOpts)) {
      void _;
    }
    expect(userOpts.env).toEqual({ OTHER: 'value' });
  });
});

describe('wrapQuery — observer', () => {
  beforeEach(() => {
    resetInjectCcTelemetry();
    resetLogger();
  });

  afterEach(() => {
    resetInjectCcTelemetry();
    resetLogger();
  });

  test('emits one kelet.reasoning record per ThinkingBlock yielded', async () => {
    const logger = new _CapturingLogger();
    setLogger(logger);

    async function* original(..._args: unknown[]): AsyncIterable<unknown> {
      yield {
        message_id: 'msg-1',
        session_id: 'sess-A',
        content: [
          { thinking: 'first thought', signature: 'sig1' },
          { thinking: 'second thought', signature: 'sig2' },
          { type: 'text', text: 'visible reply' },
        ],
      };
    }

    const wrapped = wrapQuery(original, () => TEST_CONFIG, _FakeClaudeAgentOptions);
    const items: unknown[] = [];
    for await (const item of wrapped('prompt')) {
      items.push(item);
    }

    expect(items).toHaveLength(1);
    expect(logger.records).toHaveLength(2);
    expect(logger.records[0]!.body).toBe(REASONING_EVENT_NAME);
    expect(logger.records[0]!.eventName).toBe(REASONING_EVENT_NAME);
    expect(logger.records[0]!.attributes!['reasoning.text']).toBe('first thought');
    expect(logger.records[0]!.attributes!['reasoning.signature']).toBe('sig1');
    expect(logger.records[0]!.attributes!['reasoning.message_id']).toBe('msg-1');
    expect(logger.records[0]!.attributes!['session.id']).toBe('sess-A');
    expect(logger.records[1]!.attributes!['reasoning.text']).toBe('second thought');
  });

  test('handles TS-shape envelope (msg.message.content)', async () => {
    const logger = new _CapturingLogger();
    setLogger(logger);

    async function* original(..._args: unknown[]): AsyncIterable<unknown> {
      yield {
        message: {
          id: 'msg-2',
          session_id: 'sess-B',
          content: [{ thinking: 'ts-shape thought', signature: 'sig' }],
        },
      };
    }

    const wrapped = wrapQuery(original, () => TEST_CONFIG, _FakeClaudeAgentOptions);
    for await (const _ of wrapped('prompt')) {
      void _;
    }

    expect(logger.records).toHaveLength(1);
    expect(logger.records[0]!.attributes!['reasoning.text']).toBe('ts-shape thought');
    expect(logger.records[0]!.attributes!['reasoning.message_id']).toBe('msg-2');
    expect(logger.records[0]!.attributes!['session.id']).toBe('sess-B');
  });

  test('caches sticky session id across the stream', async () => {
    const logger = new _CapturingLogger();
    setLogger(logger);

    async function* original(..._args: unknown[]): AsyncIterable<unknown> {
      // First message has session_id; second doesn't.
      yield {
        message_id: 'm1',
        session_id: 'sess-X',
        content: [{ thinking: 'first', signature: '' }],
      };
      yield {
        message_id: 'm2',
        content: [{ thinking: 'second', signature: '' }],
      };
    }

    const wrapped = wrapQuery(original, () => TEST_CONFIG, _FakeClaudeAgentOptions);
    for await (const _ of wrapped('prompt')) {
      void _;
    }

    expect(logger.records).toHaveLength(2);
    expect(logger.records[0]!.attributes!['session.id']).toBe('sess-X');
    expect(logger.records[1]!.attributes!['session.id']).toBe('sess-X');
  });

  test('silently no-ops when no logger is set', async () => {
    // No setLogger call.
    async function* original(..._args: unknown[]): AsyncIterable<unknown> {
      yield { content: [{ thinking: 'silent', signature: '' }] };
    }
    const wrapped = wrapQuery(original, () => TEST_CONFIG, _FakeClaudeAgentOptions);
    // Should not throw.
    for await (const _ of wrapped('prompt')) {
      void _;
    }
    // Sanity: nothing crashed.
    expect(true).toBe(true);
  });

  test('observer failures do not propagate into user iteration', async () => {
    const explodingLogger: MinimalLogger = {
      emit() {
        throw new Error('logger boom');
      },
    };
    setLogger(explodingLogger);

    async function* original(..._args: unknown[]): AsyncIterable<unknown> {
      yield { content: [{ thinking: 'oops', signature: '' }] };
      yield { content: [{ thinking: 'recovered', signature: '' }] };
    }
    const wrapped = wrapQuery(original, () => TEST_CONFIG, _FakeClaudeAgentOptions);
    let count = 0;
    for await (const _ of wrapped('prompt')) {
      count += 1;
      void _;
    }
    expect(count).toBe(2);
  });

  test('non-thinking blocks are ignored', async () => {
    const logger = new _CapturingLogger();
    setLogger(logger);

    async function* original(..._args: unknown[]): AsyncIterable<unknown> {
      yield {
        content: [
          { type: 'text', text: 'visible' },
          { thinking: 42, signature: 'wrong-type' },  // thinking must be string
        ],
      };
    }
    const wrapped = wrapQuery(original, () => TEST_CONFIG, _FakeClaudeAgentOptions);
    for await (const _ of wrapped('prompt')) {
      void _;
    }
    expect(logger.records).toHaveLength(0);
  });
});

describe('wrapClaudeSDKClient — env injection', () => {
  class _FakeClient {
    constructorOpts: unknown;
    constructor(options?: unknown) {
      this.constructorOpts = options;
    }
    async *receive_messages(): AsyncIterable<unknown> {
      yield { content: [{ thinking: 'inner-thought', signature: '' }] };
    }
    async *receive_response(): AsyncIterable<unknown> {
      yield { content: [{ thinking: 'response-thought', signature: '' }] };
    }
  }

  beforeEach(() => {
    resetInjectCcTelemetry();
    resetLogger();
  });

  afterEach(() => {
    resetInjectCcTelemetry();
    resetLogger();
  });

  test('materializes options when none passed and injects env', () => {
    const Wrapped = wrapClaudeSDKClient(
      _FakeClient as unknown as new (o?: unknown) => object,
      () => TEST_CONFIG,
      _FakeClaudeAgentOptions
    );
    const inst = new Wrapped() as unknown as _FakeClient;
    const opts = inst.constructorOpts as _FakeClaudeAgentOptions;
    expect(opts).toBeDefined();
    expect(opts.env).toBeDefined();
    expect(opts.env!.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('1');
  });

  test('passes through user-provided options.env (set-if-missing)', () => {
    const Wrapped = wrapClaudeSDKClient(
      _FakeClient as unknown as new (o?: unknown) => object,
      () => TEST_CONFIG,
      _FakeClaudeAgentOptions
    );
    const userOpts = new _FakeClaudeAgentOptions();
    userOpts.env = { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://user.example' };
    new Wrapped(userOpts);
    expect(userOpts.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('https://user.example');
    expect(userOpts.env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('1');
  });

  test('observer fires on receive_messages', async () => {
    const logger = new _CapturingLogger();
    setLogger(logger);
    const Wrapped = wrapClaudeSDKClient(
      _FakeClient as unknown as new (o?: unknown) => object,
      () => TEST_CONFIG,
      _FakeClaudeAgentOptions
    );
    const inst = new Wrapped() as unknown as _FakeClient;
    for await (const _ of inst.receive_messages()) {
      void _;
    }
    expect(logger.records).toHaveLength(1);
    expect(logger.records[0]!.attributes!['reasoning.text']).toBe('inner-thought');
  });

  test('observer fires on receive_response', async () => {
    const logger = new _CapturingLogger();
    setLogger(logger);
    const Wrapped = wrapClaudeSDKClient(
      _FakeClient as unknown as new (o?: unknown) => object,
      () => TEST_CONFIG,
      _FakeClaudeAgentOptions
    );
    const inst = new Wrapped() as unknown as _FakeClient;
    for await (const _ of inst.receive_response()) {
      void _;
    }
    expect(logger.records).toHaveLength(1);
    expect(logger.records[0]!.attributes!['reasoning.text']).toBe('response-thought');
  });
});
