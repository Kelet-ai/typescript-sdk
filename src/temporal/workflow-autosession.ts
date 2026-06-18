/**
 * Workflow-VM enabler for the run-ID auto-session fallback.
 *
 * The workflow VM is an isolated realm: ``KeletPlugin`` (worker process) can't
 * pass a value into it, only choose which module paths to load via
 * ``workflowModules``. So the *presence* of this module is the on/off signal —
 * the plugin appends its path only when ``activityAutoSession === true``. Its
 * top-level side effect flips a ``globalThis`` flag (one global object per
 * workflow, recreated identically on replay → deterministic) that
 * ``workflow-interceptors`` reads.
 *
 * @internal
 */

const FLAG = '__keletRunIdAutoSession';

// Top-level side effect: loading this module enables the fallback.
(globalThis as Record<string, unknown>)[FLAG] = true;

/** Whether the workflow-inbound run-ID fallback is enabled in this VM. */
export function isRunIdAutoSessionEnabled(): boolean {
  return (globalThis as Record<string, unknown>)[FLAG] === true;
}
