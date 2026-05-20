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
 * import { query, ClaudeSDKClient } from '@anthropic-ai/claude-agent-sdk';
 *
 * // After
 * import { query, ClaudeSDKClient } from 'kelet/claude-agent-sdk/shim';
 * ```
 *
 * The wrapped `query` and `ClaudeSDKClient` are pre-installed at module
 * load. All other exports pass through unchanged.
 *
 * @module claude-agent-sdk/shim
 */

import { resolveConfig, type KeletConfig } from '../config';
import { wrapClaudeSDKClient, wrapQuery } from './reasoningObserver';

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
const _originalClient = _cas['ClaudeSDKClient'] as
  | (new (options?: unknown) => object)
  | undefined;

export * from '@anthropic-ai/claude-agent-sdk';

function _throwMissingExport(name: string): never {
  throw new Error(
    `[kelet/claude-agent-sdk/shim] '@anthropic-ai/claude-agent-sdk' did not export '${name}'. ` +
      `This usually means an unsupported version is installed — Kelet's shim expects ` +
      `the public 'query' / 'ClaudeSDKClient' symbols.`
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

/**
 * Wrapped `ClaudeSDKClient` — same constructor as the upstream class,
 * with env-injection at construction and ThinkingBlock observer on
 * `receive_messages` / `receive_response`.
 *
 * If the upstream package didn't expose `ClaudeSDKClient`, instantiation
 * throws with a clear message (deferred until `new` so the import doesn't
 * fail at load time).
 */
export const ClaudeSDKClient: new (options?: unknown) => object = _originalClient
  ? wrapClaudeSDKClient(_originalClient, configResolver, ClaudeAgentOptionsCtor)
  : (class {
      constructor() {
        _throwMissingExport('ClaudeSDKClient');
      }
    } as unknown as new (options?: unknown) => object);
