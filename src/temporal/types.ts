/**
 * Shared types for the Kelet Temporal interceptors.
 * @internal
 */

import type { Info as ActivityInfo } from '@temporalio/activity';

/** Auto-derive an activity-side session when no header is present.
 *
 * - ``false`` (default): no auto-derivation.
 * - ``true``: derive from ``info.workflowExecution.workflowId`` via
 *   {@link deriveSessionId}.
 * - ``(info) => string | undefined``: custom resolver. **Must be deterministic.**
 */
export type ActivityAutoSession =
  | boolean
  | ((info: ActivityInfo) => string | undefined);

/** Auto-derive a client-stamped session for outbound ``start_workflow`` calls
 * when the caller didn't wrap the start in ``agenticSession()``.
 *
 * Note: only fires for workflows started via the same TS client. Workflows
 * started from other clients / CLI / schedules won't get a header, and the
 * worker will see no session — use ``activityAutoSession`` to backstop on
 * the activity side, or always wrap your starts in ``agenticSession``.
 */
export type ClientAutoSession =
  | boolean
  | ((input: { workflowType: string; workflowId: string }) => string | undefined);
