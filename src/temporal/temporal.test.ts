/**
 * Tests for ``kelet/temporal`` — KeletPlugin + interceptors.
 *
 * Mirrors the Python test structure (classes A–I per the design diagram) but
 * uses ``bun:test`` ``describe`` blocks since TS doesn't have pytest classes.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { defaultPayloadConverter, type Headers } from '@temporalio/common';
import { Resource } from '@opentelemetry/resources';
import { NoopSpanProcessor } from '@opentelemetry/sdk-trace-base';
import {
  OpenTelemetryPlugin,
  OpenTelemetryWorkflowClientInterceptor,
} from '@temporalio/interceptors-opentelemetry';

import { agenticSession } from '../context';
import {
  SESSION_HEADER,
  USER_HEADER,
  METADATA_HEADER,
  inject,
  extract,
  deriveSessionId,
} from './headers';
import { buildClientInterceptor } from './client-interceptors';
import { buildActivityInterceptorsFactory } from './activity-interceptors';
import { KeletPlugin } from './index';

// ───────────────── helpers ─────────────────

function _decodePayloadString(headers: Headers, key: string): string {
  const p = headers[key];
  if (p === undefined) throw new Error(`header ${key} missing`);
  return defaultPayloadConverter.fromPayload<string>(p);
}

function _decodePayloadObject(headers: Headers, key: string): unknown {
  const p = headers[key];
  if (p === undefined) throw new Error(`header ${key} missing`);
  return defaultPayloadConverter.fromPayload<unknown>(p);
}

function _otelOpts() {
  return {
    resource: new Resource({}),
    spanProcessor: new NoopSpanProcessor(),
  };
}

const _capturedConsole: { warns: unknown[][]; infos: unknown[][] } = {
  warns: [],
  infos: [],
};
let _originalWarn: typeof console.warn;
let _originalInfo: typeof console.info;

beforeEach(() => {
  _capturedConsole.warns = [];
  _capturedConsole.infos = [];
  _originalWarn = console.warn;
  _originalInfo = console.info;
  console.warn = (...args: unknown[]) => _capturedConsole.warns.push(args);
  console.info = (...args: unknown[]) => _capturedConsole.infos.push(args);
});
afterEach(() => {
  console.warn = _originalWarn;
  console.info = _originalInfo;
});

// ───────────────── headers (low-level) ─────────────────

describe('headers: inject/extract roundtrip', () => {
  test('inject returns headers unchanged when payload is undefined', () => {
    const orig: Headers = {};
    expect(inject(orig, undefined)).toBe(orig);
  });

  test('roundtrip session only', () => {
    const out = inject({}, { sessionId: 'sess-1' });
    expect(SESSION_HEADER in out).toBe(true);
    expect(USER_HEADER in out).toBe(false);
    expect(METADATA_HEADER in out).toBe(false);
    expect(extract(out)).toEqual({
      sessionId: 'sess-1',
      userId: undefined,
      metadata: undefined,
    });
  });

  test('roundtrip with user and metadata', () => {
    const meta = { tier: 'pro', count: 42 };
    const out = inject({}, { sessionId: 'sess-1', userId: 'u-1', metadata: meta });
    expect(extract(out)).toEqual({
      sessionId: 'sess-1',
      userId: 'u-1',
      metadata: meta,
    });
  });

  test('extract returns undefined when no session header', () => {
    expect(extract({})).toBeUndefined();
  });
});

describe('deriveSessionId', () => {
  test('extracts segment after /session/', () => {
    expect(deriveSessionId('acme/prod/session/sess-XYZ')).toBe('sess-XYZ');
  });
  test('returns full id when no /session/ marker', () => {
    expect(deriveSessionId('plain-wf-id')).toBe('plain-wf-id');
    expect(deriveSessionId('a/b/c/d')).toBe('a/b/c/d');
  });
  test('returns full id when /session/ is the last segment', () => {
    expect(deriveSessionId('a/b/session')).toBe('a/b/session');
  });
});

// ───────────────── A. Client outbound ─────────────────

describe('A. Client outbound', () => {
  test('A1: agenticSession set → start stamps header', async () => {
    const client = buildClientInterceptor(false);
    const next = mock(async (_input: unknown) => 'wf-run-id');
    await agenticSession({ sessionId: 'sess-A1' }, async () => {
      await client.start!({ workflowType: 'W', headers: {}, options: {} } as never, next);
    });
    const forwarded = next.mock.calls[0]![0] as { headers: Headers };
    expect(_decodePayloadString(forwarded.headers, SESSION_HEADER)).toBe('sess-A1');
  });

  test('A2: no agenticSession → no header', async () => {
    const client = buildClientInterceptor(false);
    const next = mock(async (_input: unknown) => 'wf-run-id');
    await client.start!(
      { workflowType: 'W', headers: {}, options: { workflowId: 'wf-1' } } as never,
      next,
    );
    const forwarded = next.mock.calls[0]![0] as { headers: Headers };
    expect(SESSION_HEADER in forwarded.headers).toBe(false);
  });

  test('A3: session + user + metadata all stamped', async () => {
    const client = buildClientInterceptor(false);
    const next = mock(async (_input: unknown) => 'wf-run-id');
    await agenticSession(
      { sessionId: 'sess-A3', userId: 'user-7', metadata: { tier: 'pro', count: 42 } },
      async () => {
        await client.start!(
          { workflowType: 'W', headers: {}, options: { workflowId: 'wf-1' } } as never,
          next,
        );
      },
    );
    const forwarded = next.mock.calls[0]![0] as { headers: Headers };
    expect(_decodePayloadString(forwarded.headers, SESSION_HEADER)).toBe('sess-A3');
    expect(_decodePayloadString(forwarded.headers, USER_HEADER)).toBe('user-7');
    expect(_decodePayloadObject(forwarded.headers, METADATA_HEADER)).toEqual({
      tier: 'pro',
      count: 42,
    });
  });

  test('A4: no agenticSession + autoSession=true → derives from workflowId', async () => {
    const client = buildClientInterceptor(true);
    const next = mock(async (_input: unknown) => 'wf-run-id');
    await client.start!(
      {
        workflowType: 'W',
        headers: {},
        options: { workflowId: 'acme/prod/session/sess-A4' },
      } as never,
      next,
    );
    const forwarded = next.mock.calls[0]![0] as { headers: Headers };
    expect(_decodePayloadString(forwarded.headers, SESSION_HEADER)).toBe('sess-A4');
  });

  test('A5: autoSession=callable invoked with workflowType + workflowId', async () => {
    const captured: { workflowType: string; workflowId: string }[] = [];
    const client = buildClientInterceptor((info) => {
      captured.push(info);
      return `derived-${info.workflowId}`;
    });
    const next = mock(async (_input: unknown) => 'wf-run-id');
    await client.start!(
      { workflowType: 'MyWf', headers: {}, options: { workflowId: 'wf-id-99' } } as never,
      next,
    );
    expect(captured).toEqual([{ workflowType: 'MyWf', workflowId: 'wf-id-99' }]);
    const forwarded = next.mock.calls[0]![0] as { headers: Headers };
    expect(_decodePayloadString(forwarded.headers, SESSION_HEADER)).toBe('derived-wf-id-99');
  });

  test('A5b: autoSession=true with missing workflowId does not throw — server-generated IDs are common', async () => {
    // Temporal's WorkflowStartInput.options.workflowId is optional. When the
    // user calls client.start({ workflowType: 'X' }) without an explicit ID,
    // Temporal server generates one. We can't derive client-side, so skip.
    const client = buildClientInterceptor(true);
    const next = mock(async (_input: unknown) => 'wf-run-id');
    await expect(
      client.start!(
        // workflowId is intentionally undefined here.
        { workflowType: 'MyWf', headers: {}, options: {} } as never,
        next,
      ),
    ).resolves.toBe('wf-run-id');
    const forwarded = next.mock.calls[0]![0] as { headers: Headers };
    expect(SESSION_HEADER in forwarded.headers).toBe(false);
  });

  test('A6: signal stamps header from agenticSession', async () => {
    const client = buildClientInterceptor(false);
    const next = mock(async (_input: unknown) => undefined);
    await agenticSession({ sessionId: 'sess-A6' }, async () => {
      await client.signal!(
        { signalName: 's', args: [], workflowExecution: { workflowId: 'w' }, headers: {} } as never,
        next,
      );
    });
    const forwarded = next.mock.calls[0]![0] as { headers: Headers };
    expect(_decodePayloadString(forwarded.headers, SESSION_HEADER)).toBe('sess-A6');
  });
});

// ───────────────── E. Activity inbound ─────────────────
// (Workflow-side B/C/D/F are exercised at runtime inside the workflow VM only.
//  Without spinning up a TestWorkflowEnvironment, we cover them via headers.ts
//  unit tests above and the workflow-interceptors module compilation check.)

describe('E. Activity inbound', () => {
  function _stubCtx(workflowId = 'acme/prod/session/sess-E') {
    return {
      info: {
        workflowExecution: { workflowId, runId: 'run-1' },
        workflowType: 'W',
        activityId: 'act-1',
      },
    } as never;
  }

  test('E1: header → opens agenticSession', async () => {
    const factory = buildActivityInterceptorsFactory(false);
    const interceptors = factory(_stubCtx());
    const inbound = interceptors.inbound!;
    const next = mock(async (_input: unknown) => {
      return { sessionId: undefined as string | undefined };
    });
    // Capture session inside next:
    const seen: string[] = [];
    const capturingNext = async () => {
      const { getSessionId } = await import('../context');
      seen.push(getSessionId() ?? '<none>');
    };
    await inbound.execute!(
      {
        args: [],
        headers: inject({}, { sessionId: 'sess-E1', userId: 'u-1' }),
      },
      capturingNext as never,
    );
    expect(seen).toEqual(['sess-E1']);
    expect(next.mock.calls.length).toBe(0); // unused
  });

  test('E2: no header + autoSession=true → derives from workflowId', async () => {
    const factory = buildActivityInterceptorsFactory(true);
    const interceptors = factory(_stubCtx('acme/prod/session/sess-E2'));
    const inbound = interceptors.inbound!;
    const seen: string[] = [];
    const capturingNext = async () => {
      const { getSessionId } = await import('../context');
      seen.push(getSessionId() ?? '<none>');
    };
    await inbound.execute!({ args: [], headers: {} }, capturingNext as never);
    expect(seen).toEqual(['sess-E2']);
  });

  test('E3: no header + autoSession=false → passes through', async () => {
    const factory = buildActivityInterceptorsFactory(false);
    const interceptors = factory(_stubCtx());
    const inbound = interceptors.inbound!;
    const seen: string[] = [];
    const capturingNext = async () => {
      const { getSessionId } = await import('../context');
      seen.push(getSessionId() ?? '<none>');
    };
    await inbound.execute!({ args: [], headers: {} }, capturingNext as never);
    expect(seen).toEqual(['<none>']);
  });
});

// ───────────────── G. Plugin composition ─────────────────

describe('G. Plugin composition', () => {
  test('G1: includeOtelPlugin=true (default) configures OTel into client', () => {
    const plugin = new KeletPlugin({ otelPluginOptions: _otelOpts() });
    const out = plugin.configureClient({ connection: {} as never });
    const interceptors = out.interceptors;
    const wf = Array.isArray(interceptors?.workflow) ? interceptors!.workflow! : [];
    expect(
      wf.some((i) => i instanceof OpenTelemetryWorkflowClientInterceptor),
    ).toBe(true);
  });

  test('G1b: includeOtelPlugin=true requires otelPluginOptions', () => {
    expect(() => new KeletPlugin()).toThrow(
      /requires.*otelPluginOptions/i,
    );
  });

  test('G2: includeOtelPlugin=false + no other OTel → warn', () => {
    const plugin = new KeletPlugin({ includeOtelPlugin: false });
    plugin.configureClient({ connection: {} as never });
    const warns = _capturedConsole.warns.flat().map(String);
    expect(
      warns.some((m) =>
        m.includes('includeOtelPlugin=false') && m.includes('not be linked'),
      ),
    ).toBe(true);
  });

  test('G3: includeOtelPlugin=false but OTel already present → no warning', () => {
    const plugin = new KeletPlugin({ includeOtelPlugin: false });
    const otelPlugin = new OpenTelemetryPlugin(_otelOpts());
    let cfg = otelPlugin.configureClient({ connection: {} as never });
    cfg = plugin.configureClient(cfg);
    const warns = _capturedConsole.warns.flat().map(String);
    expect(warns.some((m) => m.includes('includeOtelPlugin=false'))).toBe(false);
  });

  test('G4: two plugin instances retain independent autoSession', async () => {
    const a = new KeletPlugin({
      autoSession: true,
      otelPluginOptions: _otelOpts(),
    });
    const b = new KeletPlugin({
      autoSession: (info) => `custom-${info.workflowId}`,
      otelPluginOptions: _otelOpts(),
    });
    // Plugins build independent client interceptors via clientInterceptors closure.
    // Verify by inspecting the configured client interceptors after configureClient.
    const cfgA = a.configureClient({ connection: {} as never });
    const cfgB = b.configureClient({ connection: {} as never });
    const wfA = Array.isArray(cfgA.interceptors?.workflow)
      ? cfgA.interceptors!.workflow!
      : [];
    const wfB = Array.isArray(cfgB.interceptors?.workflow)
      ? cfgB.interceptors!.workflow!
      : [];
    // Run start through each, verify they derive different sessions.
    const nextA = mock(async (_i: unknown) => 'wfA');
    const nextB = mock(async (_i: unknown) => 'wfB');
    // Only call our own (Kelet) interceptors — last in each list because we
    // append to existing OTel interceptors.
    const keletA = wfA[wfA.length - 1]!;
    const keletB = wfB[wfB.length - 1]!;
    await keletA.start!(
      { workflowType: 'W', headers: {}, options: { workflowId: 'acme/session/X' } } as never,
      nextA,
    );
    await keletB.start!(
      { workflowType: 'W', headers: {}, options: { workflowId: 'acme/session/X' } } as never,
      nextB,
    );
    const headersA = (nextA.mock.calls[0]![0] as { headers: Headers }).headers;
    const headersB = (nextB.mock.calls[0]![0] as { headers: Headers }).headers;
    expect(_decodePayloadString(headersA, SESSION_HEADER)).toBe('X');
    expect(_decodePayloadString(headersB, SESSION_HEADER)).toBe('custom-acme/session/X');
  });

  test('G6: existing OpenTelemetryWorkflowClientInterceptor → bundled OTel skipped', () => {
    const plugin = new KeletPlugin({ otelPluginOptions: _otelOpts() });
    const otelPlugin = new OpenTelemetryPlugin(_otelOpts());

    // First the user runs OTel plugin (registering its interceptor)
    let cfg = otelPlugin.configureClient({ connection: {} as never });
    // Then KeletPlugin
    cfg = plugin.configureClient(cfg);

    const interceptors = cfg.interceptors;
    const wf = Array.isArray(interceptors?.workflow) ? interceptors!.workflow! : [];
    const otelCount = wf.filter(
      (i) => i instanceof OpenTelemetryWorkflowClientInterceptor,
    ).length;
    expect(otelCount).toBe(1); // bundled OTel was skipped, only user's remains
    const infos = _capturedConsole.infos.flat().map(String);
    expect(
      infos.some((m) => m.includes('skipping bundled OpenTelemetryPlugin')),
    ).toBe(true);
  });
});

// ───────────────── workflow-interceptors module ─────────────────

describe('workflow-interceptors module', () => {
  // Loaded via require to mirror how the worker loads it via workflowsPath.
  // We cannot exercise it fully without a TestWorkflowEnvironment, but a
  // smoke import + factory call ensures the file compiles and conforms to
  // the WorkflowInterceptorsFactory shape.
  test('exports an interceptors factory returning {inbound, outbound}', async () => {
    const mod = (await import('./workflow-interceptors')) as {
      interceptors: () => {
        inbound?: unknown[];
        outbound?: unknown[];
      };
    };
    const { inbound, outbound } = mod.interceptors();
    expect(Array.isArray(inbound)).toBe(true);
    expect(Array.isArray(outbound)).toBe(true);
    expect(inbound!.length).toBe(1);
    expect(outbound!.length).toBe(1);
  });
});
