/**
 * Claude Agent SDK observer + env-injection — `--import` loader entry point.
 *
 * Hooks `@anthropic-ai/claude-agent-sdk` at module load so destructured
 * imports (`import { query } from '@anthropic-ai/claude-agent-sdk'`) get
 * the wrapped exports — frozen ESM bindings prevent post-import patching
 * from being visible to the user's local `query` reference.
 *
 * Usage:
 * ```bash
 * node --import kelet/claude-agent-sdk/register app.js
 * npx tsx --import kelet/claude-agent-sdk/register app.ts
 * ```
 *
 * Combined with `kelet.configure()` in the app: configure() handles
 * Layer A (`process.env`); this loader handles Layer B (the public
 * `query` / `ClaudeSDKClient` exports).
 *
 * Runtime compatibility:
 * - Node.js / tsx: full support.
 * - Bun: NOT SUPPORTED — use `kelet/claude-agent-sdk/shim` shim instead. Bun
 *   does not run `--import` loader hooks.
 *
 * @module claude-agent-sdk/register
 */

import { Hook } from 'import-in-the-middle';
import { resolveConfig, type KeletConfig } from '../config';
import { wrapClaudeSDKClient, wrapQuery } from './reasoningObserver';

const debug = (msg: string) =>
  process.env.DEBUG?.includes('kelet') && console.log(`[kelet] ${msg}`);

// Register OTEL loader hook for ESM (Node.js only). We don't need the OTEL
// hook itself, but importing the iitm Hook on Bun would crash; the same
// guard pattern as `reasoning/register.ts`.
declare const Bun: unknown;
if (typeof Bun === 'undefined') {
  const { register } = await import('module');
  register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);
}

const configResolver = (): KeletConfig | null => {
  try {
    return resolveConfig();
  } catch {
    return null;
  }
};

new Hook(['@anthropic-ai/claude-agent-sdk'], (exports: Record<string, unknown>) => {
  const ClaudeAgentOptionsCtor = (exports['ClaudeAgentOptions'] ?? null) as
    | (new () => { env?: Record<string, string> })
    | null;

  if (typeof exports['query'] === 'function') {
    const original = exports['query'] as (...args: unknown[]) => AsyncIterable<unknown>;
    exports['query'] = wrapQuery(original, configResolver, ClaudeAgentOptionsCtor);
  }

  if (typeof exports['ClaudeSDKClient'] === 'function') {
    const Original = exports['ClaudeSDKClient'] as new (options?: unknown) => object;
    exports['ClaudeSDKClient'] = wrapClaudeSDKClient(Original, configResolver, ClaudeAgentOptionsCtor);
  }

  debug('Hooked @anthropic-ai/claude-agent-sdk (query, ClaudeSDKClient)');
});

debug('Claude Agent SDK loader hook registered');
