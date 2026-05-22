/**
 * Tests for the `claude_code.sdk_query` wrapper span emission.
 *
 * The Kelet server's per-session reconciler (`_attach_kelet_sdk_wrappers_to_cc_groups`)
 * matches on scope `kelet.claude_agent_sdk` + span name `claude_code.sdk_query`
 * to roll multi-`query()` workflows under one Kelet session. These tests verify
 * the SDK actually emits that span around both install paths (namespace mutation
 * via `installReasoningObserver`, and shim/register via `wrapQuery`).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { SpanStatusCode, trace } from '@opentelemetry/api';

import { installReasoningObserver, type ClaudeAgentSDKModule } from './index';
import { wrapQuery } from './reasoningObserver';
import {
  WRAPPER_SCOPE_NAME,
  WRAPPER_SPAN_NAME,
  bracketAsyncIterable,
} from './wrapperSpan';
import { agenticSession, SESSION_ID_ATTR, USER_ID_ATTR } from '../context';
import { KeletSpanProcessor } from '../processor';

describe('wrapper span emission', () => {
  let exporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider();
    provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
    // OTel's `setGlobalTracerProvider` silently no-ops on re-registration,
    // so reach the unsafe override slot the same way the SDK's setup.ts
    // does indirectly via `provider.register()`.
    trace.setGlobalTracerProvider(provider);
  });

  afterEach(async () => {
    trace.disable();
    await provider.shutdown();
  });

  test('bracketAsyncIterable opens span before first yield, ends after exhaustion', async () => {
    async function* source() {
      yield 1;
      yield 2;
    }

    const wrapped = bracketAsyncIterable(source());
    const items: number[] = [];
    for await (const item of wrapped) {
      items.push(item as number);
    }

    expect(items).toEqual([1, 2]);
    const spans = exporter.getFinishedSpans();
    const wrapperSpans = spans.filter(
      (s) => s.instrumentationLibrary.name === WRAPPER_SCOPE_NAME,
    );
    expect(wrapperSpans).toHaveLength(1);
    expect(wrapperSpans[0]!.name).toBe(WRAPPER_SPAN_NAME);
    // Span ended after iteration completed.
    expect(wrapperSpans[0]!.endTime[0]).toBeGreaterThanOrEqual(
      wrapperSpans[0]!.startTime[0],
    );
  });

  test('bracketAsyncIterable records exception + ERROR status when iteration throws', async () => {
    const boom = new Error('inner failure');
    async function* source() {
      yield 1;
      throw boom;
    }

    const wrapped = bracketAsyncIterable(source());
    let caught: unknown;
    try {
      for await (const _ of wrapped) {
        // drain until throw
      }
    } catch (err) {
      caught = err;
    }

    // Error semantics preserved for the user iterator.
    expect(caught).toBe(boom);

    const wrapperSpans = exporter
      .getFinishedSpans()
      .filter((s) => s.instrumentationLibrary.name === WRAPPER_SCOPE_NAME);
    expect(wrapperSpans).toHaveLength(1);
    const span = wrapperSpans[0]!;
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message).toBe('inner failure');
    // recordException emits an exception event on the span.
    const exceptionEvents = span.events.filter((e) => e.name === 'exception');
    expect(exceptionEvents).toHaveLength(1);
  });

  test('bracketAsyncIterable ends span on early break', async () => {
    async function* source() {
      yield 1;
      yield 2;
      yield 3;
    }

    const wrapped = bracketAsyncIterable(source());
    for await (const item of wrapped) {
      if (item === 1) break;
    }

    const wrapperSpans = exporter
      .getFinishedSpans()
      .filter((s) => s.instrumentationLibrary.name === WRAPPER_SCOPE_NAME);
    expect(wrapperSpans).toHaveLength(1);
  });

  test('installReasoningObserver brackets module-level query() with wrapper span', async () => {
    const sdk: ClaudeAgentSDKModule = {
      query: () => {
        async function* gen() {
          yield { type: 'assistant', content: [] };
        }
        return gen() as unknown as AsyncIterable<unknown> & Record<string, unknown>;
      },
    } as unknown as ClaudeAgentSDKModule;

    installReasoningObserver(sdk);

    for await (const _ of sdk.query({ prompt: 'go' })) {
      // drain
    }

    const wrapperSpans = exporter
      .getFinishedSpans()
      .filter((s) => s.instrumentationLibrary.name === WRAPPER_SCOPE_NAME);
    expect(wrapperSpans).toHaveLength(1);
    expect(wrapperSpans[0]!.name).toBe(WRAPPER_SPAN_NAME);
  });

  test('wrapQuery (shim/register path) brackets with wrapper span', async () => {
    async function* original(): AsyncIterable<unknown> {
      yield { type: 'assistant', content: [] };
    }

    const wrapped = wrapQuery(
      original as unknown as (...args: unknown[]) => AsyncIterable<unknown>,
      () => null, // no Kelet config — env injection is a no-op
      null,
    );

    for await (const _ of wrapped({ prompt: 'go' })) {
      // drain
    }

    const wrapperSpans = exporter
      .getFinishedSpans()
      .filter((s) => s.instrumentationLibrary.name === WRAPPER_SCOPE_NAME);
    expect(wrapperSpans).toHaveLength(1);
    expect(wrapperSpans[0]!.name).toBe(WRAPPER_SPAN_NAME);
  });

  test('double-install (wrapQuery + installReasoningObserver) emits exactly one wrapper span per query()', async () => {
    // Reproduces the configure()-path double-bracket: setup.ts runs both
    // Layer B (`installClaudeAgentSDK` → `wrapQuery`) and Layer A
    // (`installReasoningObserver`) on the same module. Without the
    // bracketed-marker sentinel, each user `query()` call emits TWO
    // overlapping `claude_code.sdk_query` spans.
    async function* origGen(): AsyncIterable<unknown> {
      yield { type: 'assistant', content: [] };
    }

    // Layer B first: replaces mod.query with wrapQuery'd version.
    const layerBWrapped = wrapQuery(
      origGen as unknown as (...args: unknown[]) => AsyncIterable<unknown>,
      () => null,
      null,
    );
    const sdk: ClaudeAgentSDKModule = {
      query: layerBWrapped as unknown as ClaudeAgentSDKModule['query'],
    } as unknown as ClaudeAgentSDKModule;

    // Layer A on top: must detect the bracketed marker on layerBWrapped
    // and skip its own bracket.
    installReasoningObserver(sdk);

    for await (const _ of sdk.query({ prompt: 'go' })) {
      // drain
    }

    const wrapperSpans = exporter
      .getFinishedSpans()
      .filter((s) => s.instrumentationLibrary.name === WRAPPER_SCOPE_NAME);
    expect(wrapperSpans).toHaveLength(1);
  });

  test('wrapper span carries gen_ai.conversation.id when started inside agenticSession', async () => {
    // Slice B composition test. The KeletSpanProcessor stamps
    // `gen_ai.conversation.id` and `user.id` on every span started while
    // an `agenticSession` is active. The wrapper span's `bracketAsyncIterable`
    // calls `tracer.startSpan()` which inherits the active OTel context;
    // ALS context is also active because we wrap the iteration in
    // `agenticSession(...)`. So the wrapper span ends up tagged.
    //
    // Replace the global tracer provider with one that has a
    // KeletSpanProcessor in the chain, so onStart fires before the wrapper
    // span is captured by the exporter.
    trace.disable();
    await provider.shutdown();
    exporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider();
    provider.addSpanProcessor(
      new KeletSpanProcessor(new SimpleSpanProcessor(exporter), {
        project: 'p',
      }),
    );
    trace.setGlobalTracerProvider(provider);

    const sdk: ClaudeAgentSDKModule = {
      query: () => {
        async function* gen() {
          yield { type: 'assistant', content: [] };
        }
        return gen() as unknown as AsyncIterable<unknown> & Record<string, unknown>;
      },
    } as unknown as ClaudeAgentSDKModule;
    installReasoningObserver(sdk);

    await agenticSession(
      { sessionId: 'sess-X', userId: 'u-1' },
      async () => {
        for await (const _ of sdk.query({ prompt: 'go' })) {
          // drain
        }
      },
    );

    const wrapperSpans = exporter
      .getFinishedSpans()
      .filter((s) => s.instrumentationLibrary.name === WRAPPER_SCOPE_NAME);
    expect(wrapperSpans).toHaveLength(1);
    expect(wrapperSpans[0]!.attributes[SESSION_ID_ATTR]).toBe('sess-X');
    expect(wrapperSpans[0]!.attributes[USER_ID_ATTR]).toBe('u-1');
  });

  test('wrapper span has no gen_ai.conversation.id outside agenticSession', async () => {
    trace.disable();
    await provider.shutdown();
    exporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider();
    provider.addSpanProcessor(
      new KeletSpanProcessor(new SimpleSpanProcessor(exporter), {
        project: 'p',
      }),
    );
    trace.setGlobalTracerProvider(provider);

    const sdk: ClaudeAgentSDKModule = {
      query: () => {
        async function* gen() {
          yield { type: 'assistant', content: [] };
        }
        return gen() as unknown as AsyncIterable<unknown> & Record<string, unknown>;
      },
    } as unknown as ClaudeAgentSDKModule;
    installReasoningObserver(sdk);

    for await (const _ of sdk.query({ prompt: 'go' })) {
      // drain
    }

    const wrapperSpans = exporter
      .getFinishedSpans()
      .filter((s) => s.instrumentationLibrary.name === WRAPPER_SCOPE_NAME);
    expect(wrapperSpans).toHaveLength(1);
    expect(wrapperSpans[0]!.attributes[SESSION_ID_ATTR]).toBeUndefined();
  });

  test('multiple query() calls emit multiple wrapper spans', async () => {
    const sdk: ClaudeAgentSDKModule = {
      query: () => {
        async function* gen() {
          yield { type: 'assistant', content: [] };
        }
        return gen() as unknown as AsyncIterable<unknown> & Record<string, unknown>;
      },
    } as unknown as ClaudeAgentSDKModule;

    installReasoningObserver(sdk);

    for (let i = 0; i < 3; i++) {
      for await (const _ of sdk.query({ prompt: `q-${i}` })) {
        // drain
      }
    }

    const wrapperSpans = exporter
      .getFinishedSpans()
      .filter((s) => s.instrumentationLibrary.name === WRAPPER_SCOPE_NAME);
    expect(wrapperSpans).toHaveLength(3);
  });
});
