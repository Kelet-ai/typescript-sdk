import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  CC_OTLP_ENV_KEYS,
  _resetWarnedKeys,
  buildCcEnv,
  formatDeferredWarning,
  formatOptOutSoftWarning,
  mergeIntoOptions,
  populateProcessEnv,
} from './envInjection';
import type { KeletConfig } from '../config';

const TEST_CONFIG: KeletConfig = {
  apiKey: 'test-key',
  project: 'test-project',
  apiUrl: 'http://localhost:5002',
};

describe('buildCcEnv', () => {
  test('returns exactly the seven OTLP keys', () => {
    const env = buildCcEnv(TEST_CONFIG);
    const keys = Object.keys(env).sort();
    expect(keys).toEqual([...CC_OTLP_ENV_KEYS].sort());
  });

  test('embeds api_key + project in OTEL_EXPORTER_OTLP_HEADERS', () => {
    const env = buildCcEnv(TEST_CONFIG);
    expect(env.OTEL_EXPORTER_OTLP_HEADERS).toBe(
      'authorization=test-key,x-kelet-project=test-project'
    );
  });

  test('uses cfg.apiUrl as endpoint', () => {
    const env = buildCcEnv(TEST_CONFIG);
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://localhost:5002');
  });

  test('sets fixed exporter values', () => {
    const env = buildCcEnv(TEST_CONFIG);
    expect(env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('1');
    expect(env.OTEL_LOGS_EXPORTER).toBe('otlp');
    expect(env.OTEL_METRICS_EXPORTER).toBe('otlp');
    expect(env.OTEL_TRACES_EXPORTER).toBe('otlp');
    expect(env.OTEL_EXPORTER_OTLP_PROTOCOL).toBe('http/protobuf');
  });
});

describe('populateProcessEnv (Layer A)', () => {
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    _resetWarnedKeys();
    for (const key of CC_OTLP_ENV_KEYS) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    _resetWarnedKeys();
    for (const key of CC_OTLP_ENV_KEYS) {
      const orig = originalEnv[key];
      if (orig === undefined) delete process.env[key];
      else process.env[key] = orig;
    }
  });

  test('injects all seven keys when process.env is empty', () => {
    const result = populateProcessEnv(TEST_CONFIG);
    expect(result.injected.sort()).toEqual([...CC_OTLP_ENV_KEYS].sort());
    expect(result.deferred).toEqual([]);
    expect(process.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://localhost:5002');
  });

  test('does not override an existing non-empty value (deferred)', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://other-backend.example';
    const result = populateProcessEnv(TEST_CONFIG);
    expect(result.injected).not.toContain('OTEL_EXPORTER_OTLP_ENDPOINT');
    expect(result.deferred).toContain('OTEL_EXPORTER_OTLP_ENDPOINT');
    expect(process.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('https://other-backend.example');
  });

  test('treats empty string as unset and overrides', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = '';
    const result = populateProcessEnv(TEST_CONFIG);
    expect(result.injected).toContain('OTEL_EXPORTER_OTLP_ENDPOINT');
    expect(result.deferred).toEqual([]);
    expect(process.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://localhost:5002');
  });

  test('silent no-op when existing value matches Kelet value', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:5002';
    const result = populateProcessEnv(TEST_CONFIG);
    expect(result.injected).not.toContain('OTEL_EXPORTER_OTLP_ENDPOINT');
    expect(result.deferred).not.toContain('OTEL_EXPORTER_OTLP_ENDPOINT');
  });

  test('one-shot dedup: same key not reported deferred twice', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://other.example';
    const first = populateProcessEnv(TEST_CONFIG);
    const second = populateProcessEnv(TEST_CONFIG);
    expect(first.deferred).toContain('OTEL_EXPORTER_OTLP_ENDPOINT');
    expect(second.deferred).not.toContain('OTEL_EXPORTER_OTLP_ENDPOINT');
  });
});

describe('mergeIntoOptions (Layer B)', () => {
  test('returns a new object with all seven keys when input is undefined', () => {
    const merged = mergeIntoOptions(undefined, TEST_CONFIG);
    for (const key of CC_OTLP_ENV_KEYS) {
      expect(merged[key]).toBeDefined();
    }
  });

  test('preserves user-supplied keys (set-if-missing)', () => {
    const optionsEnv = {
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://user-pinned.example',
    };
    const merged = mergeIntoOptions(optionsEnv, TEST_CONFIG);
    expect(merged.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('https://user-pinned.example');
    // Other six injected.
    expect(merged.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('1');
    expect(merged.OTEL_EXPORTER_OTLP_HEADERS).toContain('authorization=test-key');
  });

  test('does not mutate the input object', () => {
    const optionsEnv = { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://x.example' };
    const optionsEnvSnapshot = { ...optionsEnv };
    mergeIntoOptions(optionsEnv, TEST_CONFIG);
    expect(optionsEnv).toEqual(optionsEnvSnapshot);
  });

  test('preserves unrelated keys the caller passed', () => {
    const optionsEnv = { MY_CUSTOM_VAR: 'value' };
    const merged = mergeIntoOptions(optionsEnv, TEST_CONFIG);
    expect(merged.MY_CUSTOM_VAR).toBe('value');
    expect(merged.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('1');
  });
});

describe('formatDeferredWarning', () => {
  test('lists deferred keys sorted alphabetically', () => {
    const msg = formatDeferredWarning([
      'OTEL_EXPORTER_OTLP_ENDPOINT',
      'CLAUDE_CODE_ENABLE_TELEMETRY',
    ]);
    expect(msg).toContain('CLAUDE_CODE_ENABLE_TELEMETRY, OTEL_EXPORTER_OTLP_ENDPOINT');
  });

  test('mentions the opt-out flag', () => {
    const msg = formatDeferredWarning(['OTEL_EXPORTER_OTLP_ENDPOINT']);
    expect(msg).toContain('injectCcTelemetry');
  });

  test('says Kelet did NOT override', () => {
    const msg = formatDeferredWarning(['OTEL_EXPORTER_OTLP_ENDPOINT']);
    expect(msg).toContain('did NOT override');
  });
});

describe('formatOptOutSoftWarning', () => {
  test('mentions CLAUDE_CODE_ENABLE_TELEMETRY', () => {
    const msg = formatOptOutSoftWarning();
    expect(msg).toContain('CLAUDE_CODE_ENABLE_TELEMETRY');
  });
});
