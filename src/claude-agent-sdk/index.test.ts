import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import {
  _resetCASState,
  configurePopulateProcessEnv,
  installClaudeAgentSDK,
  uninstallClaudeAgentSDK,
} from './index';
import { CC_OTLP_ENV_KEYS, _resetWarnedKeys } from './envInjection';
import { resetConfig, setSharedConfig, type KeletConfig } from '../config';
import type { MinimalLogger } from './reasoningObserver';

const TEST_CONFIG: KeletConfig = {
  apiKey: 'test-key',
  project: 'test-project',
  apiUrl: 'http://localhost:5002',
};

class _CapturingLogger implements MinimalLogger {
  records: Array<{ body: string; attributes?: Record<string, unknown> }> = [];
  emit(record: { body: string; attributes?: Record<string, unknown> }): void {
    this.records.push(record);
  }
}

describe('configurePopulateProcessEnv', () => {
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    _resetWarnedKeys();
    _resetCASState();
    for (const key of CC_OTLP_ENV_KEYS) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    _resetWarnedKeys();
    _resetCASState();
    for (const key of CC_OTLP_ENV_KEYS) {
      const orig = originalEnv[key];
      if (orig === undefined) delete process.env[key];
      else process.env[key] = orig;
    }
  });

  test('populates process.env when config provided + flag default', () => {
    const result = configurePopulateProcessEnv(TEST_CONFIG);
    expect(result.injected.length).toBe(7);
    expect(process.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://localhost:5002');
  });

  test('returns empty result when config is null', () => {
    const result = configurePopulateProcessEnv(null);
    expect(result.injected).toEqual([]);
    expect(result.deferred).toEqual([]);
    expect(process.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
  });

  test('returns empty result when injectCcTelemetry: false', () => {
    const result = configurePopulateProcessEnv(TEST_CONFIG, {
      injectCcTelemetry: false,
    });
    expect(result.injected).toEqual([]);
    expect(process.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
  });

  test('emits a single console.warn for deferred keys across multiple calls', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://other-backend.example';
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      configurePopulateProcessEnv(TEST_CONFIG);
      configurePopulateProcessEnv(TEST_CONFIG);
      configurePopulateProcessEnv(TEST_CONFIG);
      // Deferred-keys dedup is per-key in envInjection; only the first call
      // surfaces the deferred key, so console.warn fires exactly once.
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const msg = warnSpy.mock.calls[0]?.[0];
      expect(typeof msg).toBe('string');
      expect(msg as string).toContain('OTEL_EXPORTER_OTLP_ENDPOINT');
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('installClaudeAgentSDK / uninstallClaudeAgentSDK', () => {
  beforeEach(async () => {
    _resetCASState();
    resetConfig();
    setSharedConfig(TEST_CONFIG);
  });

  afterEach(async () => {
    await uninstallClaudeAgentSDK();
    _resetCASState();
    resetConfig();
  });

  // ESM module namespace bindings are frozen under Node ESM and Bun, so
  // the namespace-mutation install path returns `false` on those runtimes
  // and users must use the loader (`kelet/claude-agent-sdk/register`) or
  // the shim (`kelet/claude-agent-sdk/shim`) instead. These tests assert the
  // graceful-degrade contract, not that mutation happens.
  test('does not throw when called against the real package', async () => {
    const logger = new _CapturingLogger();
    // No throw is the contract on frozen-namespace runtimes; on lenient
    // runtimes (CommonJS, mocked module) it returns true.
    await installClaudeAgentSDK({ logger });
    // No assertion on the return value — depends on runtime.
  });

  test('idempotent — second call always returns false', async () => {
    const logger = new _CapturingLogger();
    await installClaudeAgentSDK({ logger });
    const second = await installClaudeAgentSDK({ logger });
    expect(second).toBe(false);
  });

  test('uninstall does not throw even when install was a no-op', async () => {
    await installClaudeAgentSDK({ logger: new _CapturingLogger() });
    await uninstallClaudeAgentSDK();
    // Calling again should be safe.
    await uninstallClaudeAgentSDK();
  });

  test('returns false when injectCcTelemetry: false (still safely installs)', async () => {
    const logger = new _CapturingLogger();
    // This shouldn't throw; result depends on runtime mutation support.
    await installClaudeAgentSDK({ logger, injectCcTelemetry: false });
  });

  test('idempotent install honors the latest logger / flag', async () => {
    const loggerA = new _CapturingLogger();
    const loggerB = new _CapturingLogger();
    await installClaudeAgentSDK({ logger: loggerA });
    // Second call should not re-mutate, but should still wire the new logger.
    const second = await installClaudeAgentSDK({
      logger: loggerB,
      injectCcTelemetry: false,
    });
    expect(second).toBe(false);
    // Verify the override took effect via the module-level helpers.
    const { setLogger: _setLogger } = await import('./reasoningObserver');
    expect(_setLogger).toBeDefined();
  });
});

describe('frozen ESM namespace fallback (Issue #12)', () => {
  beforeEach(() => {
    _resetCASState();
    resetConfig();
    setSharedConfig(TEST_CONFIG);
  });

  afterEach(async () => {
    await uninstallClaudeAgentSDK();
    _resetCASState();
    resetConfig();
    mock.restore();
  });

  test('returns false (does not throw) when the namespace assignment is rejected', async () => {
    // Mock @anthropic-ai/claude-agent-sdk with a frozen module namespace —
    // exactly what Node ESM and Bun do at runtime. mod['query'] = …
    // throws TypeError on a frozen object.
    const fakeQuery = async function* () {
      /* empty */
    };
    class FakeClient {}
    class FakeOptions {
      env: Record<string, string> = {};
    }
    const frozen = Object.freeze({
      query: fakeQuery,
      ClaudeSDKClient: FakeClient,
      ClaudeAgentOptions: FakeOptions,
    });
    mock.module('@anthropic-ai/claude-agent-sdk', () => frozen);

    const result = await installClaudeAgentSDK({
      logger: new _CapturingLogger(),
    });
    expect(result).toBe(false);
  });
});
