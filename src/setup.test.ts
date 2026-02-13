import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { trace } from '@opentelemetry/api';
import { configure, resetSetup } from './setup.ts';
import { resetConfig, resolveConfig } from './config.ts';
import { SESSION_ID_ATTR, USER_ID_ATTR, agenticSession } from './context.ts';

describe('configure (setup)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetConfig();
    resetSetup();
    delete process.env.KELET_API_KEY;
    delete process.env.KELET_PROJECT;
    delete process.env.KELET_API_URL;
  });

  afterEach(() => {
    resetConfig();
    resetSetup();
    process.env = { ...originalEnv };
  });

  describe('config storage', () => {
    test('stores config for resolveConfig', () => {
      configure({ apiKey: 'test-key', project: 'test-proj' });

      const config = resolveConfig();
      expect(config.apiKey).toBe('test-key');
      expect(config.project).toBe('test-proj');
    });

    test('stores config even when apiKey is missing (no OTEL setup)', () => {
      configure({ project: 'partial-proj' });

      // resolveConfig with explicit apiKey should use stored project
      const config = resolveConfig({ apiKey: 'explicit-key' });
      expect(config.project).toBe('partial-proj');
    });
  });

  describe('OTEL pipeline setup', () => {
    test('registers a global tracer provider when no provider given', () => {
      configure({ apiKey: 'test-key', project: 'test-proj' });

      // The global provider should now produce real spans
      const tracer = trace.getTracer('test');
      const span = tracer.startSpan('test-span');
      span.end();

      // If the provider was set up, we should be able to create spans
      // (not a NoopSpan)
      expect(span.spanContext().traceId).toBeTruthy();
      expect(span.spanContext().traceId).not.toBe('00000000000000000000000000000000');
    });

    test('adds processor to provided tracerProvider', () => {
      const exporter = new InMemorySpanExporter();
      const provider = new BasicTracerProvider();
      // Add our own exporter to capture spans
      provider.addSpanProcessor(new SimpleSpanProcessor(exporter));

      configure({
        apiKey: 'test-key',
        project: 'test-proj',
        tracerProvider: provider,
      });

      const tracer = provider.getTracer('test');
      const span = tracer.startSpan('my-span');
      span.end();

      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      expect(spans[0]!.attributes['kelet.project']).toBe('test-proj');
    });

    test('stamps session attrs when inside agenticSession', () => {
      const exporter = new InMemorySpanExporter();
      const provider = new BasicTracerProvider();
      provider.addSpanProcessor(new SimpleSpanProcessor(exporter));

      configure({
        apiKey: 'test-key',
        project: 'test-proj',
        tracerProvider: provider,
      });

      const tracer = provider.getTracer('test');

      agenticSession({ sessionId: 'sess-1', userId: 'user-1' }, () => {
        const span = tracer.startSpan('session-span');
        span.end();
      });

      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      expect(spans[0]!.attributes[SESSION_ID_ATTR]).toBe('sess-1');
      expect(spans[0]!.attributes[USER_ID_ATTR]).toBe('user-1');
      expect(spans[0]!.attributes['kelet.project']).toBe('test-proj');
    });

    test('does not set up OTEL when apiKey is missing', () => {
      // Should not throw
      configure({ project: 'no-key-proj' });

      // Global provider should still be noop
      const tracer = trace.getTracer('test');
      const span = tracer.startSpan('noop-span');
      span.end();
      // Noop spans have all-zero trace IDs
      expect(span.spanContext().traceId).toBe('00000000000000000000000000000000');
    });

    test('does not double-setup on repeated calls', () => {
      const exporter = new InMemorySpanExporter();
      const provider = new BasicTracerProvider();
      provider.addSpanProcessor(new SimpleSpanProcessor(exporter));

      configure({ apiKey: 'key-1', project: 'proj-1', tracerProvider: provider });
      configure({ apiKey: 'key-2', project: 'proj-2', tracerProvider: provider });

      const tracer = provider.getTracer('test');
      const span = tracer.startSpan('span');
      span.end();

      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      // Should have attrs from the first configure call only
      expect(spans[0]!.attributes['kelet.project']).toBe('proj-1');
    });

    test('sets shared config so signal() can resolve it', () => {
      configure({ apiKey: 'shared-key', project: 'shared-proj' });

      const config = resolveConfig();
      expect(config.apiKey).toBe('shared-key');
      expect(config.project).toBe('shared-proj');
    });
  });
});
