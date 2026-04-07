import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  type KeletConfig,
  configure,
  resetConfig,
  resolveConfig,
  setSharedConfig,
} from './config.ts';

describe('config', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetConfig();
    // Clear env vars
    delete process.env.KELET_API_KEY;
    delete process.env.KELET_PROJECT;
    delete process.env.KELET_API_URL;
  });

  afterEach(() => {
    resetConfig();
    // Restore env vars
    process.env = { ...originalEnv };
  });

  describe('resolveConfig', () => {
    test('throws if no API key available', () => {
      expect(() => resolveConfig()).toThrow(
        'KELET_API_KEY required. Set KELET_API_KEY env var or call configure().'
      );
    });

    test('uses explicit parameter over everything', () => {
      process.env.KELET_API_KEY = 'env-key';
      configure({ apiKey: 'global-key', project: 'global-project' });
      setSharedConfig({ apiKey: 'shared-key', apiUrl: 'https://shared.api', project: 'shared' });

      const config = resolveConfig({ apiKey: 'explicit-key' });
      expect(config.apiKey).toBe('explicit-key');
    });

    test('uses shared config over global and env', () => {
      process.env.KELET_API_KEY = 'env-key';
      configure({ apiKey: 'global-key', project: 'global-project' });
      setSharedConfig({ apiKey: 'shared-key', apiUrl: 'https://shared.api', project: 'shared' });

      const config = resolveConfig();
      expect(config.apiKey).toBe('shared-key');
    });

    test('uses global config over env', () => {
      process.env.KELET_API_KEY = 'env-key';
      configure({ apiKey: 'global-key', project: 'global-project' });

      const config = resolveConfig();
      expect(config.apiKey).toBe('global-key');
    });

    test('uses env vars when no explicit/shared/global config', () => {
      process.env.KELET_API_KEY = 'env-key';
      process.env.KELET_PROJECT = 'env-project';
      process.env.KELET_API_URL = 'https://env.api';

      const config = resolveConfig();
      expect(config.apiKey).toBe('env-key');
      expect(config.project).toBe('env-project');
      expect(config.apiUrl).toBe('https://env.api');
    });

    test('throws when project is not configured', () => {
      process.env.KELET_API_KEY = 'env-key';
      delete process.env.KELET_PROJECT;

      expect(() => resolveConfig()).toThrow('KELET_PROJECT required');
    });

    test('resolves each field independently', () => {
      process.env.KELET_API_KEY = 'env-key';
      process.env.KELET_PROJECT = 'env-project';
      setSharedConfig({ apiKey: 'shared-key', apiUrl: 'https://shared.api', project: 'shared' });

      const config = resolveConfig({ apiKey: 'explicit-key', project: 'explicit-project' });
      expect(config.apiKey).toBe('explicit-key');
      expect(config.project).toBe('explicit-project');
      expect(config.apiUrl).toBe('https://shared.api');
    });
  });

  describe('configure', () => {
    test('sets global config', () => {
      configure({ apiKey: 'test-key', project: 'test-project' });
      const config = resolveConfig();
      expect(config.apiKey).toBe('test-key');
      expect(config.project).toBe('test-project');
    });

    test('configure() throws when project is missing', () => {
      delete process.env.KELET_PROJECT;
      expect(() => configure({ apiKey: 'test-key' })).toThrow('KELET_PROJECT required');
    });
  });

  describe('setSharedConfig', () => {
    test('sets shared config used by exporter', () => {
      const sharedConfig: KeletConfig = {
        apiKey: 'shared-key',
        project: 'shared-project',
        apiUrl: 'https://shared.api',
      };
      setSharedConfig(sharedConfig);

      const config = resolveConfig();
      expect(config.apiKey).toBe('shared-key');
      expect(config.project).toBe('shared-project');
      expect(config.apiUrl).toBe('https://shared.api');
    });
  });

  describe('resetConfig', () => {
    test('clears all config state', () => {
      configure({ apiKey: 'global-key', project: 'global-project' });
      setSharedConfig({ apiKey: 'shared-key', apiUrl: 'https://shared.api', project: 'shared' });

      resetConfig();

      expect(() => resolveConfig()).toThrow('KELET_API_KEY required');
    });
  });
});
