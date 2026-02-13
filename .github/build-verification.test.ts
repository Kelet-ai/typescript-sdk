import { describe, expect, test } from 'bun:test';

describe('Build verification', () => {
  test('all expected exports are available in the built package', async () => {
    const distIndexPath = new URL('../dist/index.d.ts', import.meta.url).pathname;
    const file = Bun.file(distIndexPath);
    const content = await file.text();

    expect(content).toBeTruthy();
    expect(content.trim()).not.toBe('export {};');

    const expectedExports = [
      'KeletExporter',
      'KeletExporterOptions',
      'signal',
      'SignalError',
      'SignalOptions',
      'configure',
      'KeletConfig',
      'KeletConfigOptions',
      'SignalSource',
      'SignalVote',
      'agenticSession',
      'getSessionId',
      'getUserId',
      'getTraceId',
      'SESSION_ID_ATTR',
      'USER_ID_ATTR',
      'AgenticSessionOptions',
      'KeletSpanProcessor',
      'KeletSpanProcessorOptions',
      'ConfigureOptions',
    ];

    expectedExports.forEach((exp) => {
      expect(content).toContain(exp);
    });
  });

  test('built JavaScript files exist and are not empty', async () => {
    const files = ['../dist/index.js', '../dist/aisdk.js', '../dist/reasoning/register.js'];

    for (const filePath of files) {
      const fullPath = new URL(filePath, import.meta.url).pathname;
      const file = Bun.file(fullPath);
      const content = await file.text();

      expect(content).toBeTruthy();
      expect(content.length).toBeGreaterThan(100);
    }
  });

  test('TypeScript declaration files exist', async () => {
    const files = ['../dist/index.d.ts', '../dist/aisdk.d.ts', '../dist/reasoning/register.d.ts'];

    for (const filePath of files) {
      const fullPath = new URL(filePath, import.meta.url).pathname;
      const file = Bun.file(fullPath);
      const exists = await file.exists();
      expect(exists).toBe(true);
    }
  });

  test('package.json exports configuration is correct', async () => {
    const packageJsonPath = new URL('../package.json', import.meta.url).pathname;
    const packageJson = await Bun.file(packageJsonPath).json();

    expect(packageJson.exports).toBeDefined();
    expect(packageJson.exports['.']).toBeDefined();
    expect(packageJson.exports['.'].types).toBe('./dist/index.d.ts');
    expect(packageJson.exports['.'].import).toBe('./dist/index.js');

    expect(packageJson.exports['./aisdk'].types).toBe('./dist/aisdk.d.ts');
    expect(packageJson.exports['./aisdk'].import).toBe('./dist/aisdk.js');

    expect(packageJson.exports['./reasoning/register'].types).toBe('./dist/reasoning/register.d.ts');
    expect(packageJson.exports['./reasoning/register'].import).toBe('./dist/reasoning/register.js');

    expect(packageJson.main).toBe('./dist/index.js');
    expect(packageJson.types).toBe('./dist/index.d.ts');
  });
});
