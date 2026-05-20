/**
 * Drop-in re-export shim for `@anthropic-ai/claude-agent-sdk` with
 * automatic OTLP env-var injection + reasoning capture.
 *
 * The Bun-compatible install path. Bun ignores `--import` loader hooks,
 * so users on Bun (or anyone who prefers a single import change over a
 * `node --import` flag) swap their import:
 *
 * ```ts
 * // Before
 * import { query } from '@anthropic-ai/claude-agent-sdk';
 *
 * // After
 * import { query } from 'kelet/claude-agent-sdk/shim';
 * ```
 *
 * The wrapped `query` is pre-installed at module load. All other exports
 * pass through unchanged.
 *
 * @module claude-agent-sdk/shim
 */

import { resolveConfig, type KeletConfig } from '../config';
import { wrapQuery } from './reasoningObserver';

import * as cas from '@anthropic-ai/claude-agent-sdk';

const configResolver = (): KeletConfig | null => {
  try {
    return resolveConfig();
  } catch {
    return null;
  }
};

const _cas = cas as unknown as Record<string, unknown>;
const ClaudeAgentOptionsCtor = (_cas['ClaudeAgentOptions'] ?? null) as
  | (new () => { env?: Record<string, string> })
  | null;

const _originalQuery = _cas['query'] as
  | ((...args: unknown[]) => AsyncIterable<unknown>)
  | undefined;

export * from '@anthropic-ai/claude-agent-sdk';

function _throwMissingExport(name: string): never {
  throw new Error(
    `[kelet/claude-agent-sdk/shim] '@anthropic-ai/claude-agent-sdk' did not export '${name}'. ` +
      `This usually means an unsupported version is installed — Kelet's shim expects ` +
      `the public '${name}' symbol.`
  );
}

/**
 * Wrapped `query()` — same signature as `@anthropic-ai/claude-agent-sdk`,
 * but with Layer B env-injection + ThinkingBlock observer applied.
 *
 * If the upstream package didn't expose `query` (e.g. an incompatible
 * version), calling this function throws with a clear message. Importing
 * the symbol is still safe — the error is deferred until call time so
 * any other shim consumer (e.g. someone re-exporting) doesn't hard-crash
 * at module load.
 */
export const query: (...args: unknown[]) => AsyncIterable<unknown> = _originalQuery
  ? wrapQuery(_originalQuery, configResolver, ClaudeAgentOptionsCtor)
  : (() => _throwMissingExport('query')) as (...args: unknown[]) => AsyncIterable<unknown>;
