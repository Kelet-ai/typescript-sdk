import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { resetConfig, resolveConfig, configure } from './config.ts';
import { KeletExporter, type KeletExporterOptions } from './exporter.ts';

describe('KeletExporter', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetConfig();
    delete process.env.KELET_API_KEY;
    delete process.env.KELET_PROJECT;
    delete process.env.KELET_API_URL;
  });

  afterEach(() => {
    resetConfig();
    process.env = { ...originalEnv };
  });

  describe('constructor', () => {
    test('throws if no API key available', () => {
      expect(() => new KeletExporter()).toThrow(
        'KELET_API_KEY required. Set KELET_API_KEY env var or call configure().'
      );
    });

    test('creates exporter with explicit config', () => {
      const exporter = new KeletExporter({
        apiKey: 'test-key',
        project: 'test-project',
        apiUrl: 'https://custom.api',
      });

      expect(exporter).toBeInstanceOf(KeletExporter);
    });

    test('creates exporter with env vars', () => {
      process.env.KELET_API_KEY = 'env-key';
      process.env.KELET_PROJECT = 'env-project';

      const exporter = new KeletExporter();

      expect(exporter).toBeInstanceOf(KeletExporter);
    });

    test('creates exporter with global config', () => {
      configure({ apiKey: 'global-key', project: 'global-project' });

      const exporter = new KeletExporter();

      expect(exporter).toBeInstanceOf(KeletExporter);
    });
  });

  describe('shared config', () => {
    test('sets shared config for signal() to use', () => {
      const exporter = new KeletExporter({
        apiKey: 'exporter-key',
        project: 'exporter-project',
        apiUrl: 'https://exporter.api',
      });

      // After exporter creation, resolveConfig should return exporter's config
      const config = resolveConfig();
      expect(config.apiKey).toBe('exporter-key');
      expect(config.project).toBe('exporter-project');
      expect(config.apiUrl).toBe('https://exporter.api');
    });

    test('explicit params still override shared config', () => {
      new KeletExporter({
        apiKey: 'exporter-key',
        project: 'exporter-project',
      });

      const config = resolveConfig({ apiKey: 'explicit-key' });
      expect(config.apiKey).toBe('explicit-key');
      expect(config.project).toBe('exporter-project');
    });
  });

  describe('OTLP configuration', () => {
    // Helper to extract URL from deeply nested OTLPTraceExporter
    function getExporterUrl(exporter: KeletExporter): string {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (exporter as any)._delegate._transport._transport._parameters.url;
    }

    test('configures correct URL', () => {
      const exporter = new KeletExporter({
        apiKey: 'test-key',
        apiUrl: 'https://custom.api',
      });

      expect(getExporterUrl(exporter)).toBe('https://custom.api/api/traces');
    });

    test('uses default URL', () => {
      const exporter = new KeletExporter({
        apiKey: 'test-key',
      });

      expect(getExporterUrl(exporter)).toBe('https://api.kelet.ai/api/traces');
    });
  });
});
