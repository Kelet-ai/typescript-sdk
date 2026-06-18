/**
 * Workflow-VM enabler for the run-ID auto-session fallback. **Side effect only.**
 *
 * The workflow VM is an isolated realm: ``KeletPlugin`` (worker process) can't
 * pass a value into it, only choose which module paths to load via
 * ``workflowModules``. So the *presence* of this module is the on/off signal —
 * the plugin appends its path only when ``activityAutoSession === true``.
 * Loading it flips a ``globalThis`` flag (one global object per workflow,
 * recreated identically on replay → deterministic) that the interceptor reads
 * via ``isRunIdAutoSessionEnabled`` from ``workflow-autosession-flag``.
 *
 * This module MUST NOT be imported by the interceptor — that would run the
 * side effect on every workflow and enable the fallback unconditionally. The
 * interceptor imports the side-effect-free flag reader instead.
 *
 * @internal
 */

import { RUN_ID_AUTOSESSION_FLAG } from './workflow-autosession-flag';

// Top-level side effect: loading this module (only ever via workflowModules
// when activityAutoSession === true) enables the fallback.
(globalThis as Record<string, unknown>)[RUN_ID_AUTOSESSION_FLAG] = true;
