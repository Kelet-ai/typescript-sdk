/**
 * Side-effect-free reader for the run-ID auto-session flag.
 *
 * Kept separate from the enabler (``workflow-autosession``) on purpose: the
 * workflow interceptor must be able to *read* the flag without *setting* it.
 * If the interceptor imported the enabler, that module's top-level side effect
 * would run on every workflow (the interceptor is always loaded) and force the
 * fallback on even when ``activityAutoSession`` is unset. Importing this module
 * does nothing — only loading the enabler flips the flag.
 *
 * @internal
 */

/** Global key carrying the run-ID auto-session flag inside the workflow VM. */
export const RUN_ID_AUTOSESSION_FLAG = '__keletRunIdAutoSession';

/** Whether the workflow-inbound run-ID fallback is enabled in this VM. */
export function isRunIdAutoSessionEnabled(): boolean {
  return (globalThis as Record<string, unknown>)[RUN_ID_AUTOSESSION_FLAG] === true;
}
