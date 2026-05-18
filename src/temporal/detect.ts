/**
 * Detect whether code is executing inside a Temporal workflow VM.
 *
 * Mirrors ``kelet._temporal_detect.in_temporal_workflow`` from the Python
 * SDK. Used by ``signal()`` (when integrated) and reserved for future
 * defensive guards in ``agenticSession()``. As of this version, the TS
 * ``agenticSession()`` only sets ``AsyncLocalStorage`` — already
 * sandbox-safe — so this helper exists for parity and forward-compat.
 *
 * Returns ``false`` if ``@temporalio/workflow`` isn't installed, or if the
 * runtime check raises for any reason. Never throws.
 *
 * @internal
 */
export function inWorkflowContext(): boolean {
  try {
    // Use a runtime-only require so consumers without @temporalio/workflow
    // installed don't pay an import-time cost.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const wf = require('@temporalio/workflow') as {
      inWorkflowContext?: () => boolean;
    };
    return wf.inWorkflowContext?.() ?? false;
  } catch {
    return false;
  }
}
