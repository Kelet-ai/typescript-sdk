import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { resetConfig, configure } from './config.ts';
import { signal } from './signal.ts';
import { SignalSource, SignalVote } from './types.ts';

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
    test('throws if neither sessionId nor traceId provided', async () => {
      await expect(
        signal({
          source: SignalSource.EXPLICIT,
          vote: SignalVote.UPVOTE,
        })
      ).rejects.toThrow(
        'Either sessionId or traceId required.'
      );
    });

    test('accepts sessionId only', async () => {
      await signal({
        source: SignalSource.EXPLICIT,
        sessionId: 'session-123',
        vote: SignalVote.UPVOTE,
      });
      expect(fetchMock).toHaveBeenCalled();
    });

    test('accepts traceId only', async () => {
      await signal({
        source: SignalSource.EXPLICIT,
        traceId: 'trace-123',
        vote: SignalVote.UPVOTE,
      });
      expect(fetchMock).toHaveBeenCalled();
    });

    test('accepts both sessionId and traceId', async () => {
      await signal({
        source: SignalSource.EXPLICIT,
        sessionId: 'session-123',
        traceId: 'trace-123',
        vote: SignalVote.UPVOTE,
      });
      expect(fetchMock).toHaveBeenCalled();
    });
  });

  describe('payload', () => {
    test('sends correct payload structure', async () => {
      await signal({
        source: SignalSource.EXPLICIT,
        sessionId: 'session-123',
        vote: SignalVote.UPVOTE,
        explanation: 'Great response!',
        triggerName: 'thumbs_up',
        selection: 'some text',
        correction: 'corrected text',
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
        source: 'EXPLICIT',
        session_id: 'session-123',
        vote: 'UPVOTE',
        explanation: 'Great response!',
        trigger_name: 'thumbs_up',
        selection: 'some text',
        correction: 'corrected text',
      });
    });

    test('excludes undefined fields from payload', async () => {
      await signal({
        source: SignalSource.IMPLICIT,
        traceId: 'trace-123',
      });

      const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string);

      expect(body).toEqual({
        source: 'IMPLICIT',
        trace_id: 'trace-123',
      });
      expect(body).not.toHaveProperty('session_id');
      expect(body).not.toHaveProperty('vote');
      expect(body).not.toHaveProperty('explanation');
    });

    test('serializes object correction to JSON string', async () => {
      await signal({
        source: SignalSource.EXPLICIT,
        sessionId: 'session-123',
        correction: { key: 'value', nested: { foo: 'bar' } },
      });

      const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string);

      expect(body.correction).toBe('{"key":"value","nested":{"foo":"bar"}}');
    });

    test('keeps string correction as-is', async () => {
      await signal({
        source: SignalSource.EXPLICIT,
        sessionId: 'session-123',
        correction: 'plain string correction',
      });

      const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string);

      expect(body.correction).toBe('plain string correction');
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
        source: SignalSource.EXPLICIT,
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
        source: SignalSource.EXPLICIT,
        sessionId: 'session-123',
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    test('retries on 503 status', async () => {
      let callCount = 0;
      fetchMock = mock(() => {
        callCount++;
        if (callCount < 2) {
          return Promise.resolve(new Response('Service Unavailable', { status: 503 }));
        }
        return Promise.resolve(new Response('{}', { status: 200 }));
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await signal({
        source: SignalSource.EXPLICIT,
        sessionId: 'session-123',
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    test('retries on 504 status', async () => {
      let callCount = 0;
      fetchMock = mock(() => {
        callCount++;
        if (callCount < 2) {
          return Promise.resolve(new Response('Gateway Timeout', { status: 504 }));
        }
        return Promise.resolve(new Response('{}', { status: 200 }));
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await signal({
        source: SignalSource.EXPLICIT,
        sessionId: 'session-123',
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    test('retries on 408 status', async () => {
      let callCount = 0;
      fetchMock = mock(() => {
        callCount++;
        if (callCount < 2) {
          return Promise.resolve(new Response('Request Timeout', { status: 408 }));
        }
        return Promise.resolve(new Response('{}', { status: 200 }));
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await signal({
        source: SignalSource.EXPLICIT,
        sessionId: 'session-123',
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    test('retries on 429 status', async () => {
      let callCount = 0;
      fetchMock = mock(() => {
        callCount++;
        if (callCount < 2) {
          return Promise.resolve(new Response('Too Many Requests', { status: 429 }));
        }
        return Promise.resolve(new Response('{}', { status: 200 }));
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await signal({
        source: SignalSource.EXPLICIT,
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
          source: SignalSource.EXPLICIT,
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
          source: SignalSource.EXPLICIT,
          sessionId: 'session-123',
        })
      ).rejects.toThrow();

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    test('throws immediately on 403 status (no retry)', async () => {
      fetchMock = mock(() =>
        Promise.resolve(new Response('Forbidden', { status: 403 }))
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await expect(
        signal({
          source: SignalSource.EXPLICIT,
          sessionId: 'session-123',
        })
      ).rejects.toThrow();

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    test('throws immediately on 404 status (no retry)', async () => {
      fetchMock = mock(() =>
        Promise.resolve(new Response('Not Found', { status: 404 }))
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await expect(
        signal({
          source: SignalSource.EXPLICIT,
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
          source: SignalSource.EXPLICIT,
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
        source: SignalSource.EXPLICIT,
        sessionId: 'session-123',
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });
});
