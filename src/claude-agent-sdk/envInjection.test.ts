import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  CC_OTLP_ENV_KEYS,
  OTEL_RESOURCE_ATTRIBUTES_KEY,
  RA_ENDUSER_ID,
  RA_KELET_PROJECT,
  RA_METADATA_PREFIX,
  RA_SESSION_ID,
  _resetResourceAttrWarnedKeys,
  _resetWarnedKeys,
  buildCcEnv,
  buildKeletResourceAttrs,
  formatDeferredWarning,
  formatOptOutSoftWarning,
  mergeIntoOptions,
  mergeResourceAttributes,
  populateProcessEnv,
} from './envInjection';
import { agenticSession } from '../context';
import type { KeletConfig } from '../config';

const TEST_CONFIG: KeletConfig = {
  apiKey: 'test-key',
  project: 'test-project',
  apiUrl: 'http://localhost:5002',
};

describe('buildCcEnv', () => {
  test('returns exactly the full OTLP key set', () => {
    const env = buildCcEnv(TEST_CONFIG);
    const keys = Object.keys(env).sort();
    expect(keys).toEqual([...CC_OTLP_ENV_KEYS].sort());
    // 7 transport + 1 trace-export gate + 4 log-content gates
    expect(keys.length).toBe(12);
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

  test('enables CC 2.1.146+ trace-export beta gate', () => {
    const env = buildCcEnv(TEST_CONFIG);
    expect(env.CLAUDE_CODE_ENHANCED_TELEMETRY_BETA).toBe('1');
  });

  test('enables log-content gates so ingestion sees un-redacted bodies', () => {
    const env = buildCcEnv(TEST_CONFIG);
    expect(env.OTEL_LOG_USER_PROMPTS).toBe('1');
    expect(env.OTEL_LOG_TOOL_DETAILS).toBe('1');
    expect(env.OTEL_LOG_TOOL_CONTENT).toBe('1');
    expect(env.OTEL_LOG_RAW_API_BODIES).toBe('1');
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

  test('injects every key when process.env is empty', () => {
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
  test('returns a new object with every key when input is undefined', () => {
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
    // Other defaults injected.
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

// ---------------------------------------------------------------------------
// OTEL_RESOURCE_ATTRIBUTES — Slice C resource-attr propagation tests.
// Mirror the Python tests (cases a-i + project gate + non-mutation).
// ---------------------------------------------------------------------------

function parseRA(value: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of value.split(',')) {
    if (!part || !part.includes('=')) continue;
    const eqIdx = part.indexOf('=');
    const k = part.slice(0, eqIdx).trim();
    const v = part.slice(eqIdx + 1);
    if (k) out[k] = v;
  }
  return out;
}

describe('OTEL_RESOURCE_ATTRIBUTES (Slice C)', () => {
  beforeEach(() => {
    _resetResourceAttrWarnedKeys();
  });

  afterEach(() => {
    _resetResourceAttrWarnedKeys();
  });

  test('a: populated inside agenticSession', async () => {
    await agenticSession(
      { sessionId: 'S', userId: 'u-1', metadata: { foo: 'bar' } },
      async () => {
        const merged = mergeIntoOptions(undefined, TEST_CONFIG);
        expect(merged[OTEL_RESOURCE_ATTRIBUTES_KEY]).toBeDefined();
        const pairs = parseRA(merged[OTEL_RESOURCE_ATTRIBUTES_KEY]!);
        expect(pairs[RA_SESSION_ID]).toBe('S');
        expect(pairs[RA_ENDUSER_ID]).toBe('u-1');
        expect(pairs['user.id']).toBeUndefined();
        expect(pairs[`${RA_METADATA_PREFIX}foo`]).toBe('bar');
        expect(pairs[RA_KELET_PROJECT]).toBe('test-project');
      }
    );
  });

  test('b: outside any agenticSession — no resource attrs', () => {
    const merged = mergeIntoOptions(undefined, TEST_CONFIG);
    expect(merged[OTEL_RESOURCE_ATTRIBUTES_KEY]).toBeUndefined();
  });

  test('c: caller pre-set service.namespace — kelet keys appended', async () => {
    await agenticSession({ sessionId: 'S' }, async () => {
      const userOpts = { [OTEL_RESOURCE_ATTRIBUTES_KEY]: 'service.namespace=foo' };
      const merged = mergeIntoOptions(userOpts, TEST_CONFIG);
      const pairs = parseRA(merged[OTEL_RESOURCE_ATTRIBUTES_KEY]!);
      expect(pairs['service.namespace']).toBe('foo');
      expect(pairs[RA_SESSION_ID]).toBe('S');
    });
  });

  test('d: caller pre-set enduser.id — their value wins', async () => {
    await agenticSession({ sessionId: 'S', userId: 'u-1' }, async () => {
      const userOpts = { [OTEL_RESOURCE_ATTRIBUTES_KEY]: 'enduser.id=other-user' };
      const merged = mergeIntoOptions(userOpts, TEST_CONFIG);
      const pairs = parseRA(merged[OTEL_RESOURCE_ATTRIBUTES_KEY]!);
      expect(pairs[RA_ENDUSER_ID]).toBe('other-user');
      expect(pairs[RA_SESSION_ID]).toBe('S');
    });
  });

  test('e: caller pre-set user.id — respect, do not touch', async () => {
    await agenticSession({ sessionId: 'S', userId: 'u-1' }, async () => {
      const userOpts = { [OTEL_RESOURCE_ATTRIBUTES_KEY]: 'user.id=svc-acct' };
      const merged = mergeIntoOptions(userOpts, TEST_CONFIG);
      const pairs = parseRA(merged[OTEL_RESOURCE_ATTRIBUTES_KEY]!);
      expect(pairs['user.id']).toBe('svc-acct');
      expect(pairs[RA_ENDUSER_ID]).toBe('u-1');
    });
  });

  test('f: percent-encoding for disallowed characters', async () => {
    await agenticSession(
      {
        sessionId: 'sess with spaces',
        userId: 'ümlaut@example.com',
        metadata: {
          comma_val: 'a,b',
          equals_val: 'a=b',
          semi_val: 'a;b',
          backslash_val: 'a\\b',
          quote_val: 'a"b',
          emoji_val: 'hello👋',
        },
      },
      async () => {
        const merged = mergeIntoOptions(undefined, TEST_CONFIG);
        const raw = merged[OTEL_RESOURCE_ATTRIBUTES_KEY]!;
        const pairs = parseRA(raw);
        expect(pairs[RA_SESSION_ID]).toContain('%20'); // space
        expect(pairs[`${RA_METADATA_PREFIX}comma_val`]).toContain('%2C'); // ,
        expect(pairs[`${RA_METADATA_PREFIX}equals_val`]).toContain('%3D'); // =
        expect(pairs[`${RA_METADATA_PREFIX}semi_val`]).toContain('%3B'); // ;
        expect(pairs[`${RA_METADATA_PREFIX}backslash_val`]).toContain('%5C'); // \
        expect(pairs[`${RA_METADATA_PREFIX}quote_val`]).toContain('%22'); // "
        // Non-ASCII / emoji → percent-encoded UTF-8 bytes
        expect(pairs[RA_ENDUSER_ID]).toContain('%C3%BC'); // ü
        expect(pairs[`${RA_METADATA_PREFIX}emoji_val`]).toContain('%F0%9F%91%8B'); // 👋
        // The split-on-comma round-trips through parseRA — verify every
        // expected key landed.
        const expectedKeys = new Set([
          RA_SESSION_ID,
          RA_ENDUSER_ID,
          RA_KELET_PROJECT,
          `${RA_METADATA_PREFIX}comma_val`,
          `${RA_METADATA_PREFIX}equals_val`,
          `${RA_METADATA_PREFIX}semi_val`,
          `${RA_METADATA_PREFIX}backslash_val`,
          `${RA_METADATA_PREFIX}quote_val`,
          `${RA_METADATA_PREFIX}emoji_val`,
        ]);
        for (const k of expectedKeys) {
          expect(pairs[k]).toBeDefined();
        }
      }
    );
  });

  test('g: non-string metadata coerced via String()', async () => {
    await agenticSession(
      {
        sessionId: 'S',
        metadata: {
          retries: 3,
          is_admin: true,
          rate: 0.5,
        },
      },
      async () => {
        const merged = mergeIntoOptions(undefined, TEST_CONFIG);
        const pairs = parseRA(merged[OTEL_RESOURCE_ATTRIBUTES_KEY]!);
        expect(pairs[`${RA_METADATA_PREFIX}retries`]).toBe('3');
        expect(pairs[`${RA_METADATA_PREFIX}is_admin`]).toBe('true');
        expect(pairs[`${RA_METADATA_PREFIX}rate`]).toBe('0.5');
      }
    );
  });

  test('h: total > 16 KiB — metadata.* dropped, core kept, WARN emitted', async () => {
    const origWarn = console.warn;
    const captured: string[] = [];
    console.warn = (...args: unknown[]): void => {
      captured.push(args.map((a) => String(a)).join(' '));
    };
    try {
      const bigMetadata: Record<string, string> = {};
      for (let i = 0; i < 100; i++) {
        bigMetadata[`k${i}`] = 'x'.repeat(200);
      }
      await agenticSession(
        { sessionId: 'S', userId: 'u-1', metadata: bigMetadata },
        async () => {
          const merged = mergeIntoOptions(undefined, TEST_CONFIG);
          const pairs = parseRA(merged[OTEL_RESOURCE_ATTRIBUTES_KEY]!);
          // Core keys preserved.
          expect(pairs[RA_SESSION_ID]).toBe('S');
          expect(pairs[RA_ENDUSER_ID]).toBe('u-1');
          // Metadata partially dropped.
          const metaKept = Object.keys(pairs).filter((k) =>
            k.startsWith(RA_METADATA_PREFIX)
          );
          expect(metaKept.length).toBeLessThan(100);
        }
      );
      expect(
        captured.some((m) => m.includes('OTEL_RESOURCE_ATTRIBUTES exceeded'))
      ).toBe(true);
    } finally {
      console.warn = origWarn;
    }
  });

  test('i: per-key isolation — bad toString() skipped, rest kept', () => {
    const origWarn = console.warn;
    const captured: string[] = [];
    console.warn = (...args: unknown[]): void => {
      captured.push(args.map((a) => String(a)).join(' '));
    };
    try {
      class BadObj {
        toString(): string {
          throw new Error('boom');
        }
      }
      // Sneak a non-primitive through the typed metadata API — at runtime
      // users may end up with this shape via dynamic JS construction.
      const bad = new BadObj() as unknown as string;
      let resultPairs: Record<string, string> = {};
      agenticSession(
        {
          sessionId: 'S',
          metadata: { good: 'ok', bad } as Record<string, string>,
        },
        () => {
          resultPairs = buildKeletResourceAttrs({ project: 'p' });
        }
      );
      expect(resultPairs[RA_SESSION_ID]).toBe('S');
      expect(resultPairs[`${RA_METADATA_PREFIX}good`]).toBe('ok');
      expect(resultPairs[`${RA_METADATA_PREFIX}bad`]).toBeUndefined();
      expect(
        captured.some(
          (m) => m.includes('failed to encode') && m.includes('metadata.bad')
        )
      ).toBe(true);
    } finally {
      console.warn = origWarn;
    }
  });

  test('kelet.project always injected from config', async () => {
    await agenticSession({ sessionId: 'S', userId: 'u-1' }, async () => {
      const merged = mergeIntoOptions(undefined, TEST_CONFIG);
      const pairs = parseRA(merged[OTEL_RESOURCE_ATTRIBUTES_KEY]!);
      expect(pairs[RA_KELET_PROJECT]).toBe('test-project');
    });
  });

  test('mergeResourceAttributes returns a new dict, does not mutate input', async () => {
    await agenticSession({ sessionId: 'S' }, async () => {
      const userOpts = { [OTEL_RESOURCE_ATTRIBUTES_KEY]: 'service.namespace=foo' };
      const snapshot = { ...userOpts };
      mergeIntoOptions(userOpts, TEST_CONFIG);
      expect(userOpts).toEqual(snapshot);
    });
  });

  test('mergeResourceAttributes — caller value wins per-key', () => {
    const out = mergeResourceAttributes({
      callerValue: 'gen_ai.conversation.id=A,enduser.id=B',
      keletPairs: {
        [RA_SESSION_ID]: 'X',
        [RA_ENDUSER_ID]: 'Y',
        [`${RA_METADATA_PREFIX}foo`]: 'baz',
      },
    });
    const pairs = parseRA(out);
    expect(pairs[RA_SESSION_ID]).toBe('A');
    expect(pairs[RA_ENDUSER_ID]).toBe('B');
    expect(pairs[`${RA_METADATA_PREFIX}foo`]).toBe('baz');
  });
});
