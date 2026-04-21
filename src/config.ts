/**
 * Configuration management for Kelet SDK.
 * @module config
 */

/**
 * Configuration options for Kelet SDK.
 */
export interface KeletConfig {
  /** API key for authentication. */
  apiKey: string;
  /** Project identifier. */
  project: string;
  /** Base URL for API requests. */
  apiUrl: string;
}

/**
 * Partial configuration options (all fields optional).
 */
export type KeletConfigOptions = Partial<KeletConfig>;

// Module-level state
let _globalConfig: KeletConfigOptions | undefined;
let _sharedConfig: KeletConfig | undefined;

/**
 * Store global configuration defaults for Kelet SDK.
 *
 * Values set here are used when not overridden by explicit parameters
 * or shared config (from KeletExporter). No validation is performed —
 * strict checks happen in {@link resolveConfig}. This function is called
 * internally by {@link import('./setup').configure}, which wraps it with
 * warn-and-no-op semantics for missing credentials.
 *
 * @internal
 * @param options - Configuration options
 */
export function configure(options: KeletConfigOptions): void {
  _globalConfig = options;
}

/**
 * Set shared config (called by KeletExporter).
 *
 * This is used internally by KeletExporter to share its resolved
 * configuration with other SDK functions like signal().
 *
 * @internal
 * @param config - Full configuration from exporter
 */
export function setSharedConfig(config: KeletConfig): void {
  _sharedConfig = config;
}

/**
 * Reset all configuration state.
 *
 * Primarily used for testing to ensure clean state between tests.
 *
 * @internal
 */
export function resetConfig(): void {
  _globalConfig = undefined;
  _sharedConfig = undefined;
}

/**
 * Resolve configuration with priority chain.
 *
 * Priority (highest to lowest):
 * 1. Explicit parameters
 * 2. Shared config (from KeletExporter)
 * 3. Global config (from configure())
 * 4. Environment variables
 * 5. Throws if project cannot be resolved
 *
 * @param options - Optional explicit configuration overrides
 * @returns Fully resolved configuration
 * @throws {Error} If API key cannot be resolved from any source
 *
 * @example
 * ```typescript
 * // With explicit override
 * const config = resolveConfig({ apiKey: 'override-key' });
 *
 * // Using configured defaults
 * configure({ apiKey: 'default-key' });
 * const config = resolveConfig();
 * ```
 */
export function resolveConfig(options?: KeletConfigOptions): KeletConfig {
  const apiKey =
    options?.apiKey ??
    _sharedConfig?.apiKey ??
    _globalConfig?.apiKey ??
    process.env.KELET_API_KEY;

  if (!apiKey) {
    throw new Error(
      'KELET_API_KEY required. Set KELET_API_KEY env var or call configure().'
    );
  }

  const project =
    options?.project ??
    _sharedConfig?.project ??
    _globalConfig?.project ??
    process.env.KELET_PROJECT;

  if (!project) {
    throw new Error(
      'KELET_PROJECT required. Set the KELET_PROJECT env var or pass project: to configure().\n' +
      'Create a project at https://console.kelet.ai'
    );
  }

  let apiUrl =
    options?.apiUrl ??
    _sharedConfig?.apiUrl ??
    _globalConfig?.apiUrl ??
    process.env.KELET_API_URL ??
    'https://api.kelet.ai';

  if (apiUrl.endsWith('/api')) {
    apiUrl = apiUrl.slice(0, -4);
  }
  if (apiUrl.endsWith('/')) {
    apiUrl = apiUrl.slice(0, -1);
  }

  return { apiKey, project, apiUrl };
}
