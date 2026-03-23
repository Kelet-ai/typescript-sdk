import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { agenticSession, SESSION_ID_ATTR, USER_ID_ATTR } from './context.ts';
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

  test('stamps metadata on child spans', () => {
    const tracer = provider.getTracer('test');

    agenticSession({ sessionId: 's1', metadata: { $kelet_internal: true } }, () => {
      const span = tracer.startSpan('child');
      span.end();
    });

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.attributes['metadata.$kelet_internal']).toBe(true);
  });

  test('nested session metadata propagation', () => {
    const tracer = provider.getTracer('test');

    agenticSession({ sessionId: 'outer', metadata: { env: 'prod', version: 1 } }, () => {
      agenticSession({ sessionId: 'inner', metadata: { feature: 'beta' } }, () => {
        const span = tracer.startSpan('inner-child');
        span.end();
      });
    });

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.attributes['metadata.env']).toBe('prod');
    expect(spans[0]!.attributes['metadata.version']).toBe(1);
    expect(spans[0]!.attributes['metadata.feature']).toBe('beta');
  });
});
