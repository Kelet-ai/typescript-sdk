import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { context as otelContext, propagation } from '@opentelemetry/api';
import { agenticSession, withAgent, SESSION_ID_ATTR, USER_ID_ATTR } from './context.ts';
import { KeletSpanProcessor } from './processor.ts';

describe('KeletSpanProcessor', () => {
  let exporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    const inner = new SimpleSpanProcessor(exporter);
    const keletProcessor = new KeletSpanProcessor(inner, { project: 'test-proj' });

    provider = new BasicTracerProvider();
    provider.addSpanProcessor(keletProcessor);
  });

  afterEach(async () => {
    await provider.shutdown();
  });

  test('stamps kelet.project on every span', () => {
    const tracer = provider.getTracer('test');
    const span = tracer.startSpan('op');
    span.end();

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.attributes['kelet.project']).toBe('test-proj');
  });

  test('stamps session/user attrs inside agenticSession', () => {
    const tracer = provider.getTracer('test');

    agenticSession({ sessionId: 'sess-1', userId: 'user-1' }, () => {
      const span = tracer.startSpan('op');
      span.end();
    });

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.attributes[SESSION_ID_ATTR]).toBe('sess-1');
    expect(spans[0]!.attributes[USER_ID_ATTR]).toBe('user-1');
  });

  test('stamps sessionId without userId when userId omitted', () => {
    const tracer = provider.getTracer('test');

    agenticSession({ sessionId: 'sess-only' }, () => {
      const span = tracer.startSpan('op');
      span.end();
    });

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.attributes[SESSION_ID_ATTR]).toBe('sess-only');
    expect(spans[0]!.attributes[USER_ID_ATTR]).toBeUndefined();
  });

  test('deeply nested spans inherit session attrs', () => {
    const tracer = provider.getTracer('test');

    agenticSession({ sessionId: 'sess-deep', userId: 'user-deep' }, () => {
      const parent = tracer.startSpan('parent');
      const child = tracer.startSpan('child');
      const grandchild = tracer.startSpan('grandchild');
      grandchild.end();
      child.end();
      parent.end();
    });

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(3);
    for (const span of spans) {
      expect(span.attributes[SESSION_ID_ATTR]).toBe('sess-deep');
      expect(span.attributes[USER_ID_ATTR]).toBe('user-deep');
      expect(span.attributes['kelet.project']).toBe('test-proj');
    }
  });

  test('spans outside agenticSession have no session attrs', () => {
    const tracer = provider.getTracer('test');

    const span = tracer.startSpan('outside');
    span.end();

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.attributes[SESSION_ID_ATTR]).toBeUndefined();
    expect(spans[0]!.attributes[USER_ID_ATTR]).toBeUndefined();
    // kelet.project is always set
    expect(spans[0]!.attributes['kelet.project']).toBe('test-proj');
  });

  test('no leakage after session exit', () => {
    const tracer = provider.getTracer('test');

    agenticSession({ sessionId: 'sess-leak' }, () => {
      const inner = tracer.startSpan('inner');
      inner.end();
    });

    const outer = tracer.startSpan('outer');
    outer.end();

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(2);

    const innerSpan = spans.find((s) => s.name === 'inner')!;
    const outerSpan = spans.find((s) => s.name === 'outer')!;

    expect(innerSpan.attributes[SESSION_ID_ATTR]).toBe('sess-leak');
    expect(outerSpan.attributes[SESSION_ID_ATTR]).toBeUndefined();
  });

  test('stamps gen_ai.agent.name inside withAgent', () => {
    const tracer = provider.getTracer('test');
    withAgent({ name: 'support-bot' }, () => {
      const span = tracer.startSpan('op');
      span.end();
    });
    const spans = exporter.getFinishedSpans();
    // withAgent creates its own span + the 'op' span
    const opSpan = spans.find((s) => s.name === 'op')!;
    expect(opSpan.attributes['gen_ai.agent.name']).toBe('support-bot');
  });

  test('does not stamp gen_ai.agent.name when outside withAgent', () => {
    const tracer = provider.getTracer('test');
    agenticSession({ sessionId: 'sess-2' }, () => {
      const span = tracer.startSpan('op');
      span.end();
    });
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.attributes['gen_ai.agent.name']).toBeUndefined();
  });

  test('no gen_ai.agent.name leak after withAgent exits', () => {
    const tracer = provider.getTracer('test');
    withAgent({ name: 'temp-agent' }, () => {
      const inner = tracer.startSpan('inner');
      inner.end();
    });
    const outer = tracer.startSpan('outer');
    outer.end();
    const spans = exporter.getFinishedSpans();
    const innerSpan = spans.find((s) => s.name === 'inner')!;
    const outerSpan = spans.find((s) => s.name === 'outer')!;
    expect(innerSpan.attributes['gen_ai.agent.name']).toBe('temp-agent');
    expect(outerSpan.attributes['gen_ai.agent.name']).toBeUndefined();
  });

  test('project override in agenticSession overrides global project', () => {
    const tracer = provider.getTracer('test');

    agenticSession({ sessionId: 'sess-proj', project: 'override-proj' }, () => {
      const span = tracer.startSpan('op');
      span.end();
    });

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.attributes['kelet.project']).toBe('override-proj');
  });

  test('agenticSession without project uses global project', () => {
    const tracer = provider.getTracer('test');

    agenticSession({ sessionId: 'sess-no-proj' }, () => {
      const span = tracer.startSpan('op');
      span.end();
    });

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.attributes['kelet.project']).toBe('test-proj');
  });

  test('baggage context propagates session/user/project without agenticSession', () => {
    const tracer = provider.getTracer('test');

    // Simulate a cross-process scenario: build a context carrying W3C baggage
    // and pass it directly to startSpan (as a downstream service would receive it).
    const bag = propagation.createBaggage({
      'kelet.session_id': { value: 'baggage-sess' },
      'kelet.user_id': { value: 'baggage-user' },
      'kelet.project': { value: 'baggage-proj' },
    });
    const ctx = propagation.setBaggage(otelContext.active(), bag);

    // Pass the baggage context explicitly — simulates what happens when OTel
    // propagates the context from an upstream service into this span's parent.
    const span = tracer.startSpan('op', {}, ctx);
    span.end();

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.attributes[SESSION_ID_ATTR]).toBe('baggage-sess');
    expect(spans[0]!.attributes[USER_ID_ATTR]).toBe('baggage-user');
    expect(spans[0]!.attributes['kelet.project']).toBe('baggage-proj');
  });

  test('nested agenticSession with different projects: inner overrides, outer restores', () => {
    const tracer = provider.getTracer('test');

    agenticSession({ sessionId: 'outer', project: 'outer-proj' }, () => {
      const outerSpan = tracer.startSpan('outer-op');
      outerSpan.end();

      agenticSession({ sessionId: 'inner', project: 'inner-proj' }, () => {
        const innerSpan = tracer.startSpan('inner-op');
        innerSpan.end();
      });

      const afterInnerSpan = tracer.startSpan('after-inner-op');
      afterInnerSpan.end();
    });

    const spans = Object.fromEntries(
      exporter.getFinishedSpans().map(s => [s.name, s])
    );
    expect(spans['outer-op']!.attributes['kelet.project']).toBe('outer-proj');
    expect(spans['inner-op']!.attributes['kelet.project']).toBe('inner-proj');
    expect(spans['after-inner-op']!.attributes['kelet.project']).toBe('outer-proj');
  });

});
