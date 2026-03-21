import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  agenticSession,
  getSessionId,
  getUserId,
  getProjectOverride,
  getTraceId,
  SESSION_ID_ATTR,
  USER_ID_ATTR,
  AGENT_NAME_ATTR,
} from './context.ts';

describe('context constants', () => {
  test('SESSION_ID_ATTR is gen_ai.conversation.id', () => {
    expect(SESSION_ID_ATTR).toBe('gen_ai.conversation.id');
  });

  test('USER_ID_ATTR is user.id', () => {
    expect(USER_ID_ATTR).toBe('user.id');
  });

  test('AGENT_NAME_ATTR is gen_ai.agent.name', () => {
    expect(AGENT_NAME_ATTR).toBe('gen_ai.agent.name');
  });
});

describe('getSessionId / getUserId outside session', () => {
  test('getSessionId returns undefined outside agenticSession', () => {
    expect(getSessionId()).toBeUndefined();
  });

  test('getUserId returns undefined outside agenticSession', () => {
    expect(getUserId()).toBeUndefined();
  });

  test('getProjectOverride returns undefined outside agenticSession', () => {
    expect(getProjectOverride()).toBeUndefined();
  });
});

describe('getTraceId', () => {
  test('returns undefined when no active span', () => {
    expect(getTraceId()).toBeUndefined();
  });
});

describe('agenticSession', () => {
  test('sets sessionId readable via getSessionId', () => {
    agenticSession({ sessionId: 'sess-1' }, () => {
      expect(getSessionId()).toBe('sess-1');
    });
  });

  test('sets userId readable via getUserId', () => {
    agenticSession({ sessionId: 'sess-1', userId: 'user-1' }, () => {
      expect(getUserId()).toBe('user-1');
    });
  });

  test('userId is optional (undefined when omitted)', () => {
    agenticSession({ sessionId: 'sess-1' }, () => {
      expect(getUserId()).toBeUndefined();
    });
  });

  test('returns sync callback value', () => {
    const result = agenticSession({ sessionId: 'sess-1' }, () => {
      return 42;
    });
    expect(result).toBe(42);
  });

  test('returns async callback value', async () => {
    const result = await agenticSession({ sessionId: 'sess-1' }, async () => {
      return 'async-value';
    });
    expect(result).toBe('async-value');
  });

  test('context persists across await points', async () => {
    await agenticSession({ sessionId: 'sess-async', userId: 'user-async' }, async () => {
      expect(getSessionId()).toBe('sess-async');

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(getSessionId()).toBe('sess-async');
      expect(getUserId()).toBe('user-async');
    });
  });

  test('no leakage after sync callback returns', () => {
    agenticSession({ sessionId: 'sess-leak' }, () => {
      expect(getSessionId()).toBe('sess-leak');
    });
    expect(getSessionId()).toBeUndefined();
  });

  test('no leakage after async callback returns', async () => {
    await agenticSession({ sessionId: 'sess-leak-async' }, async () => {
      expect(getSessionId()).toBe('sess-leak-async');
    });
    expect(getSessionId()).toBeUndefined();
  });

  test('nesting: inner overrides outer, outer restores on exit', () => {
    agenticSession({ sessionId: 'outer', userId: 'user-outer' }, () => {
      expect(getSessionId()).toBe('outer');
      expect(getUserId()).toBe('user-outer');

      agenticSession({ sessionId: 'inner', userId: 'user-inner' }, () => {
        expect(getSessionId()).toBe('inner');
        expect(getUserId()).toBe('user-inner');
      });

      // Outer restored
      expect(getSessionId()).toBe('outer');
      expect(getUserId()).toBe('user-outer');
    });
  });

  test('nesting async: inner overrides outer, outer restores on exit', async () => {
    await agenticSession({ sessionId: 'outer-a' }, async () => {
      expect(getSessionId()).toBe('outer-a');

      await agenticSession({ sessionId: 'inner-a', userId: 'u-inner' }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(getSessionId()).toBe('inner-a');
        expect(getUserId()).toBe('u-inner');
      });

      expect(getSessionId()).toBe('outer-a');
      expect(getUserId()).toBeUndefined();
    });
  });

  test('sets project readable via getProjectOverride', () => {
    agenticSession({ sessionId: 'sess-1', project: 'my-project' }, () => {
      expect(getProjectOverride()).toBe('my-project');
    });
  });

  test('project is optional (undefined when omitted)', () => {
    agenticSession({ sessionId: 'sess-1' }, () => {
      expect(getProjectOverride()).toBeUndefined();
    });
  });

  test('no project leakage after session exits', () => {
    agenticSession({ sessionId: 'sess-proj', project: 'leak-test' }, () => {
      expect(getProjectOverride()).toBe('leak-test');
    });
    expect(getProjectOverride()).toBeUndefined();
  });
});
