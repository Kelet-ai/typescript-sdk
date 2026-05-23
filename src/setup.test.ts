import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { context, trace } from '@opentelemetry/api';
import {
  _resetSetupWarnState,
  _syncLayerAForTest,
  configure,
  resetSetup,
  shutdown,
} from './setup.ts';
import { resetConfig, resolveConfig } from './config.ts';
import { SESSION_ID_ATTR, USER_ID_ATTR, agenticSession } from './context.ts';

describe('configure (setup)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetConfig();
    resetSetup();
    _resetSetupWarnState();
    delete process.env.KELET_API_KEY;
    delete process.env.KELET_PROJECT;
    delete process.env.KELET_API_URL;
  });

  afterEach(() => {
    resetConfig();
    resetSetup();
    _resetSetupWarnState();
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
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
      configure({ project: 'partial-proj' });

      // resolveConfig with explicit apiKey should use stored project
      const config = resolveConfig({ apiKey: 'explicit-key' });
      expect(config.project).toBe('partial-proj');
      warnSpy.mockRestore();
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
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
      // Should not throw
      configure({ project: 'no-key-proj' });

      // Global provider should still be noop
      const tracer = trace.getTracer('test');
      const span = tracer.startSpan('noop-span');
      span.end();
      // Noop spans have all-zero trace IDs
      expect(span.spanContext().traceId).toBe('00000000000000000000000000000000');
      warnSpy.mockRestore();
    });

    test('propagates parent-child span context across await boundaries (regression for AsyncLocalStorageContextManager fix)', async () => {
      // Regression guard for the 0.8.1 fix: when configure() owns the
      // TracerProvider, BasicTracerProvider.register() previously fell
      // back to NoopContextManager — every nested span became its own
      // root. The fix installs AsyncLocalStorageContextManager so the
      // active span propagates across await.
      configure({ apiKey: 'test-key', project: 'test-proj' });

      const tracer = trace.getTracer('regression-test');
      const parent = tracer.startSpan('parent');
      let childTraceId: string | undefined;
      let childParentSpanId: string | undefined;

      await context.with(trace.setSpan(context.active(), parent), async () => {
        await new Promise((r) => setTimeout(r, 1));
        const child = tracer.startSpan('child');
        childTraceId = child.spanContext().traceId;
        // SDK Span exposes parentSpanId via the readable interface.
        const ctx = child.spanContext();
        childParentSpanId = (child as unknown as { parentSpanId?: string }).parentSpanId;
        child.end();
        // Touch ctx to satisfy the linter — needed for the readable-span cast.
        expect(ctx.traceId).toBe(childTraceId);
      });

      parent.end();

      expect(childTraceId).toBe(parent.spanContext().traceId);
      expect(childParentSpanId).toBe(parent.spanContext().spanId);
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

    test('uses provided spanProcessor instead of creating default KeletSpanProcessor', () => {
      const onEndCalls: unknown[] = [];
      const mockProcessor = {
        onStart: () => {},
        onEnd: (span: unknown) => { onEndCalls.push(span); },
        shutdown: async () => {},
        forceFlush: async () => {},
      };

      const exporter = new InMemorySpanExporter();
      const provider = new BasicTracerProvider();
      // Add a capturing exporter so we can inspect span attributes
      provider.addSpanProcessor(new SimpleSpanProcessor(exporter));

      configure({
        apiKey: 'test-key',
        project: 'test-proj',
        tracerProvider: provider,
        spanProcessor: mockProcessor,
      });

      const tracer = provider.getTracer('test');
      const span = tracer.startSpan('custom-proc-span');
      span.end();

      // The mock's onEnd was called (the custom processor was registered)
      expect(onEndCalls).toHaveLength(1);

      // KeletSpanProcessor.onStart stamps kelet.project; its absence proves it was NOT used
      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      expect(spans[0]!.attributes['kelet.project']).toBeUndefined();
    });
  });

  describe('missing credentials', () => {
    test('warns once and no-ops when apiKey is missing', () => {
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

      configure({ project: 'p' });

      const messages = warnSpy.mock.calls.map((call: unknown[]) => call[0] as string);
      const disabledMsgs = messages.filter((m: string) => m.includes('Telemetry disabled'));
      expect(disabledMsgs).toHaveLength(1);
      expect(disabledMsgs[0]).toContain('KELET_API_KEY required');
      warnSpy.mockRestore();
    });

    test('warns once and no-ops when project is missing', () => {
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

      configure({ apiKey: 'k' });

      const messages = warnSpy.mock.calls.map((call: unknown[]) => call[0] as string);
      const disabledMsgs = messages.filter((m: string) => m.includes('Telemetry disabled'));
      expect(disabledMsgs).toHaveLength(1);
      expect(disabledMsgs[0]).toContain('KELET_PROJECT required');
      warnSpy.mockRestore();
    });

    test('warn fires at most once per process even across multiple configure() calls', () => {
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

      configure({ project: 'p' });
      configure({ project: 'p' });
      configure({ project: 'p' });

      const messages = warnSpy.mock.calls.map((call: unknown[]) => call[0] as string);
      const disabledMsgs = messages.filter((m: string) => m.includes('Telemetry disabled'));
      expect(disabledMsgs).toHaveLength(1);
      warnSpy.mockRestore();
    });

    test('strict: true re-throws on missing apiKey instead of warning', () => {
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
      expect(() => configure({ project: 'p', strict: true })).toThrow('KELET_API_KEY required');
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    test('strict: true re-throws on missing project', () => {
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
      expect(() => configure({ apiKey: 'k', strict: true })).toThrow('KELET_PROJECT required');
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    test('explicit apiKey="" raises even without strict (falsy-env fallback)', () => {
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
      // Empty string fails the !apiKey check in resolveConfig; with strict=false the setup
      // layer catches and warns (no throw). The point is the empty-string is treated as missing,
      // not silently accepted as a valid key.
      configure({ apiKey: '', project: 'p' });
      const messages = warnSpy.mock.calls.map((call: unknown[]) => call[0] as string);
      const disabledMsgs = messages.filter((m: string) => m.includes('Telemetry disabled'));
      expect(disabledMsgs).toHaveLength(1);
      warnSpy.mockRestore();
    });
  });

  describe('shutdown', () => {
    test('awaits registered processor shutdown', async () => {
      let shutdownCalled = false;
      const mockProcessor = {
        onStart: () => {},
        onEnd: () => {},
        shutdown: mock(async () => {
          shutdownCalled = true;
        }),
        forceFlush: async () => {},
      };
      const provider = new BasicTracerProvider();

      configure({
        apiKey: 'test-key',
        project: 'test-proj',
        tracerProvider: provider,
        spanProcessor: mockProcessor,
      });

      await shutdown();

      expect(shutdownCalled).toBe(true);
      expect(mockProcessor.shutdown).toHaveBeenCalledTimes(1);
    });

    test('swallows errors from a failing processor', async () => {
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
      const failingProcessor = {
        onStart: () => {},
        onEnd: () => {},
        shutdown: async () => {
          throw new Error('boom');
        },
        forceFlush: async () => {},
      };
      const provider = new BasicTracerProvider();

      configure({
        apiKey: 'test-key',
        project: 'test-proj',
        tracerProvider: provider,
        spanProcessor: failingProcessor,
      });

      // Should not throw.
      await shutdown();

      expect(warnSpy).toHaveBeenCalled();
      const [msg] = warnSpy.mock.calls[0] as [string, unknown];
      expect(msg).toContain('processor shutdown failed');
      warnSpy.mockRestore();
    });

    test('is idempotent', async () => {
      const mockProcessor = {
        onStart: () => {},
        onEnd: () => {},
        shutdown: mock(async () => {}),
        forceFlush: async () => {},
      };
      const provider = new BasicTracerProvider();

      configure({
        apiKey: 'test-key',
        project: 'test-proj',
        tracerProvider: provider,
        spanProcessor: mockProcessor,
      });

      await shutdown();
      await shutdown();

      expect(mockProcessor.shutdown).toHaveBeenCalledTimes(1);
    });

    test('allows re-configure after shutdown', async () => {
      const exporter = new InMemorySpanExporter();
      const provider = new BasicTracerProvider();
      provider.addSpanProcessor(new SimpleSpanProcessor(exporter));

      configure({
        apiKey: 'test-key',
        project: 'proj-before',
        tracerProvider: provider,
      });
      await shutdown();

      configure({
        apiKey: 'test-key',
        project: 'proj-after',
        tracerProvider: provider,
      });

      const tracer = provider.getTracer('test');
      const span = tracer.startSpan('post-reconfigure');
      span.end();

      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      expect(spans[0]!.attributes['kelet.project']).toBe('proj-after');
    });
  });

  describe('AI SDK auto-registration', () => {
    test('registers @ai-sdk/otel when both ai and @ai-sdk/otel resolve', async () => {
      // Both packages are installed as devDeps, so the real
      // registerTelemetryIntegration runs against the real AI SDK global.
      // We confirm no warning fires (the silent-success path).
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

      configure({ apiKey: 'test-key', project: 'test-proj' });

      // Auto-registration is fire-and-forget; let the microtask queue drain.
      await new Promise((resolve) => setTimeout(resolve, 50));

      // No warnings about @ai-sdk/otel should have been emitted.
      const warnCalls = warnSpy.mock.calls.map((c) => String(c[0] ?? ''));
      const aiSdkWarn = warnCalls.find((m) => m.includes('@ai-sdk/otel'));
      expect(aiSdkWarn).toBeUndefined();

      warnSpy.mockRestore();
    });

    test('respects injectAiSdkTelemetry: false', async () => {
      // Should not even attempt the dynamic import path. Hard to assert
      // directly without mocking; smoke-test that configure() succeeds.
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

      configure({
        apiKey: 'test-key',
        project: 'test-proj',
        injectAiSdkTelemetry: false,
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Even with both packages present, opt-out skips auto-registration.
      // We can't easily inspect the AI SDK's global integration list here,
      // so rely on the contract: no @ai-sdk/otel warnings either way.
      const warnCalls = warnSpy.mock.calls.map((c) => String(c[0] ?? ''));
      const aiSdkWarn = warnCalls.find((m) => m.includes('@ai-sdk/otel'));
      expect(aiSdkWarn).toBeUndefined();

      warnSpy.mockRestore();
    });
  });

  describe('_syncLayerA opt-out soft warning', () => {
    test('_warnedOptOut fires exactly once per process lifecycle (fire-once guard)', () => {
      // Use _syncLayerAForTest to bypass the _configured early-return in configure().
      // This directly exercises the _warnedOptOut guard inside _syncLayerA.
      const infoSpy = spyOn(console, 'info').mockImplementation(() => {});
      delete process.env.CLAUDE_CODE_ENABLE_TELEMETRY;

      // First call: _warnedOptOut is false (reset by afterEach) → warning fires.
      _syncLayerAForTest(null, false);
      const countAfterFirst = infoSpy.mock.calls.filter((c) =>
        String(c[0] ?? '').includes('injectCcTelemetry'),
      ).length;

      // Second call within the same lifecycle: _warnedOptOut is now true → no new warning.
      _syncLayerAForTest(null, false);
      const countAfterSecond = infoSpy.mock.calls.filter((c) =>
        String(c[0] ?? '').includes('injectCcTelemetry'),
      ).length;

      expect(countAfterFirst).toBe(1);
      expect(countAfterSecond).toBe(1); // Fire-once: guard prevented second warning.

      infoSpy.mockRestore();
    });
  });
});
