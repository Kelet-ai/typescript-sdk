import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { resetConfig, configure } from './config.ts';
import { signal } from './signal.ts';
import { SignalKind, SignalSource } from './types.ts';
import { agenticSession } from './context.ts';

describe('signal', () => {
  let fetchMock: ReturnType<typeof mock>;

  beforeEach(() => {
    resetConfig();
    configure({ apiKey: 'test-key', project: 'test-project' });

    // Mock global fetch
    fetchMock = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ success: true }), { status: 200 }))
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    resetConfig();
  });

  describe('validation', () => {
    test('throws if neither sessionId nor traceId provided and no context', async () => {
      await expect(
        signal({
          kind: SignalKind.FEEDBACK,
          source: SignalSource.HUMAN,
        })
      ).rejects.toThrow(
        'Either sessionId or traceId required. Use agenticSession() or pass explicitly.'
      );
    });

    test('accepts sessionId only', async () => {
      await signal({
        kind: SignalKind.FEEDBACK,
        source: SignalSource.HUMAN,
        sessionId: 'session-123',
      });
      expect(fetchMock).toHaveBeenCalled();
    });

    test('accepts traceId only', async () => {
      await signal({
        kind: SignalKind.FEEDBACK,
        source: SignalSource.HUMAN,
        traceId: 'trace-123',
      });
      expect(fetchMock).toHaveBeenCalled();
    });

    test('accepts both sessionId and traceId', async () => {
      await signal({
        kind: SignalKind.FEEDBACK,
        source: SignalSource.HUMAN,
        sessionId: 'session-123',
        traceId: 'trace-123',
      });
      expect(fetchMock).toHaveBeenCalled();
    });

    test('throws if score is below 0', async () => {
      await expect(
        signal({
          kind: SignalKind.FEEDBACK,
          source: SignalSource.HUMAN,
          sessionId: 'session-123',
          score: -0.1,
        })
      ).rejects.toThrow('score must be between 0 and 1 (inclusive)');
    });

    test('throws if score is above 1', async () => {
      await expect(
        signal({
          kind: SignalKind.FEEDBACK,
          source: SignalSource.HUMAN,
          sessionId: 'session-123',
          score: 1.1,
        })
      ).rejects.toThrow('score must be between 0 and 1 (inclusive)');
    });

    test('throws if confidence is below 0', async () => {
      await expect(
        signal({
          kind: SignalKind.FEEDBACK,
          source: SignalSource.HUMAN,
          sessionId: 'session-123',
          confidence: -0.1,
        })
      ).rejects.toThrow('confidence must be between 0 and 1 (inclusive)');
    });

    test('throws if confidence is above 1', async () => {
      await expect(
        signal({
          kind: SignalKind.FEEDBACK,
          source: SignalSource.HUMAN,
          sessionId: 'session-123',
          confidence: 1.1,
        })
      ).rejects.toThrow('confidence must be between 0 and 1 (inclusive)');
    });

    test('accepts score at boundaries (0 and 1)', async () => {
      await signal({
        kind: SignalKind.FEEDBACK,
        source: SignalSource.HUMAN,
        sessionId: 'session-123',
        score: 0,
      });
      await signal({
        kind: SignalKind.FEEDBACK,
        source: SignalSource.HUMAN,
        sessionId: 'session-123',
        score: 1,
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('payload', () => {
    test('sends correct payload structure', async () => {
      await signal({
        kind: SignalKind.FEEDBACK,
        source: SignalSource.HUMAN,
        sessionId: 'session-123',
        triggerName: 'thumbs_down',
        score: 0.0,
        value: 'Response was wrong',
        confidence: 0.9,
        metadata: { key: 'val' },
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];

      expect(url).toBe('https://api.kelet.ai/api/projects/test-project/signal');
      expect(options.method).toBe('POST');
      expect(options.headers).toEqual({
        'Content-Type': 'application/json',
        Authorization: 'test-key',
      });

      const body = JSON.parse(options.body as string);
      expect(body).toEqual({
        kind: 'feedback',
        source: 'human',
        session_id: 'session-123',
        trigger_name: 'thumbs_down',
        score: 0.0,
        value: 'Response was wrong',
        confidence: 0.9,
        metadata: { key: 'val' },
      });
    });

    test('excludes undefined fields from payload', async () => {
      await signal({
        kind: SignalKind.EVENT,
        source: SignalSource.SYNTHETIC,
        traceId: 'trace-123',
      });

      const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string);

      expect(body).toEqual({
        kind: 'event',
        source: 'synthetic',
        trace_id: 'trace-123',
      });
      expect(body).not.toHaveProperty('session_id');
      expect(body).not.toHaveProperty('score');
      expect(body).not.toHaveProperty('value');
    });

    test('serializes Date timestamp to ISO string', async () => {
      const date = new Date('2026-01-15T10:30:00.000Z');
      await signal({
        kind: SignalKind.FEEDBACK,
        source: SignalSource.HUMAN,
        sessionId: 'session-123',
        timestamp: date,
      });

      const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string);

      expect(body.timestamp).toBe('2026-01-15T10:30:00.000Z');
    });

    test('passes string timestamp as-is', async () => {
      await signal({
        kind: SignalKind.FEEDBACK,
        source: SignalSource.HUMAN,
        sessionId: 'session-123',
        timestamp: '2026-01-15T10:30:00Z',
      });

      const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string);

      expect(body.timestamp).toBe('2026-01-15T10:30:00Z');
    });

    test('maps triggerName to trigger_name in payload', async () => {
      await signal({
        kind: SignalKind.FEEDBACK,
        source: SignalSource.HUMAN,
        sessionId: 'session-123',
        triggerName: 'thumbs_up',
      });

      const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string);

      expect(body.trigger_name).toBe('thumbs_up');
      expect(body).not.toHaveProperty('triggerName');
      expect(body).not.toHaveProperty('trigger');
    });
  });

  describe('retry logic', () => {
    test('retries on 500 status', async () => {
      let callCount = 0;
      fetchMock = mock(() => {
        callCount++;
        if (callCount < 3) {
          return Promise.resolve(new Response('Server Error', { status: 500 }));
        }
        return Promise.resolve(new Response('{}', { status: 200 }));
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await signal({
        kind: SignalKind.FEEDBACK,
        source: SignalSource.HUMAN,
        sessionId: 'session-123',
      });

      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    test('retries on 502 status', async () => {
      let callCount = 0;
      fetchMock = mock(() => {
        callCount++;
        if (callCount < 2) {
          return Promise.resolve(new Response('Bad Gateway', { status: 502 }));
        }
        return Promise.resolve(new Response('{}', { status: 200 }));
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await signal({
        kind: SignalKind.FEEDBACK,
        source: SignalSource.HUMAN,
        sessionId: 'session-123',
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    test('throws immediately on 400 status (no retry)', async () => {
      fetchMock = mock(() =>
        Promise.resolve(new Response('Bad Request', { status: 400 }))
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await expect(
        signal({
          kind: SignalKind.FEEDBACK,
          source: SignalSource.HUMAN,
          sessionId: 'session-123',
        })
      ).rejects.toThrow();

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    test('throws immediately on 401 status (no retry)', async () => {
      fetchMock = mock(() =>
        Promise.resolve(new Response('Unauthorized', { status: 401 }))
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await expect(
        signal({
          kind: SignalKind.FEEDBACK,
          source: SignalSource.HUMAN,
          sessionId: 'session-123',
        })
      ).rejects.toThrow();

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    test('throws after max retries exhausted', async () => {
      fetchMock = mock(() =>
        Promise.resolve(new Response('Server Error', { status: 500 }))
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await expect(
        signal({
          kind: SignalKind.FEEDBACK,
          source: SignalSource.HUMAN,
          sessionId: 'session-123',
        })
      ).rejects.toThrow();

      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    test('retries on network error', async () => {
      let callCount = 0;
      fetchMock = mock(() => {
        callCount++;
        if (callCount < 2) {
          return Promise.reject(new Error('Network error'));
        }
        return Promise.resolve(new Response('{}', { status: 200 }));
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await signal({
        kind: SignalKind.FEEDBACK,
        source: SignalSource.HUMAN,
        sessionId: 'session-123',
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('agenticSession context resolution', () => {
    test('resolves sessionId from agenticSession context', async () => {
      await agenticSession({ sessionId: 'ctx-sess' }, async () => {
        await signal({
          kind: SignalKind.FEEDBACK,
          source: SignalSource.HUMAN,
        });
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string);
      expect(body.session_id).toBe('ctx-sess');
    });

    test('explicit sessionId takes priority over context', async () => {
      await agenticSession({ sessionId: 'ctx-sess' }, async () => {
        await signal({
          kind: SignalKind.FEEDBACK,
          source: SignalSource.HUMAN,
          sessionId: 'explicit-sess',
        });
      });

      const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string);
      expect(body.session_id).toBe('explicit-sess');
    });

    test('explicit traceId takes priority over context', async () => {
      await agenticSession({ sessionId: 'ctx-sess' }, async () => {
        await signal({
          kind: SignalKind.FEEDBACK,
          source: SignalSource.HUMAN,
          traceId: 'explicit-trace',
        });
      });

      const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string);
      expect(body.trace_id).toBe('explicit-trace');
      expect(body.session_id).toBe('ctx-sess');
    });

    test('still throws when no context and no explicit ids', async () => {
      await expect(
        signal({
          kind: SignalKind.FEEDBACK,
          source: SignalSource.HUMAN,
        })
      ).rejects.toThrow(
        'Either sessionId or traceId required. Use agenticSession() or pass explicitly.'
      );
    });
  });
});
