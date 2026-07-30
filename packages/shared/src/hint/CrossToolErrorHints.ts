import type { ControlErrorBody } from "../error/ErrorBodyControl.js";
import { errorCodes } from "../error/ErrorCodeCatalog.js";
import { errorHint, type ToolDiagnosticHint } from "./ToolDiagnosticHint.js";

const crossToolHints: Record<string, string> = {
    [errorCodes.coreToolSchedulerFull]:
        "The call was rejected before execution because the scheduler is at capacity. Wait for running calls to finish or reduce concurrency; do not submit duplicate calls.",
    [errorCodes.coreToolQueueTimeout]:
        "The call timed out while waiting in the execution queue and its body never ran. Retry only after capacity frees up; do not retry the same operation concurrently.",
    [errorCodes.coreToolCallCancelled]:
        "The call was cancelled. If it never started, no work was performed; do not report success. Whether to retry depends on the user's intent.",
    [errorCodes.coreApprovalRequired]:
        "This operation requires explicit user approval before it may run. Wait for the user's decision; do not bypass, split, or reroute the operation through another tool.",
    [errorCodes.coreApprovalDenied]:
        "The user denied this operation. Do not retry it unchanged or achieve the same effect through another tool; re-evaluate only if the user gives a new explicit request.",
    [errorCodes.coreApprovalExpired]:
        "The previous approval has expired and is no longer valid. Request a fresh approval only if the user still explicitly wants this operation; do not assume the old approval still holds.",
    [errorCodes.coreApprovalNotFound]:
        "The referenced approval does not exist. Refresh the approval list and use a valid approval id; do not guess approval ids or create duplicate decisions.",
    [errorCodes.coreApprovalAlreadyDecided]:
        "This approval has already been decided. Refresh the approval state; do not submit another decision for it.",
    [errorCodes.coreApprovalPolicyInvalid]:
        "The approval policy configuration is invalid. Fix the specific policy field; do not disable approval or downgrade it to allow-all to bypass the check.",
    [errorCodes.coreToolSchemaUnavailable]:
        "The tool is not exposed or its schema is unavailable. Check instance capability, MCP group, and readiness; do not forge the call or bypass catalog filtering.",
    "mcp.toolSchemaUnavailable":
        "The tool schema is unavailable for this instance. Check instance readiness and capability before listing or calling tools; do not forge the call.",
    [errorCodes.coreInstanceNotReady]:
        "The target instance is not ready. Call instance_status to inspect it; do not call tools that require a ready worker, and do not auto-start the instance unless the user explicitly asks.",
    [errorCodes.coreInstanceBusy]:
        "The instance is busy with another operation. Wait for it to settle and check instance_status; do not force a concurrent operation.",
    [errorCodes.coreProviderFailed]:
        "The underlying provider operation failed. Inspect the provider type, operation, and sanitized cause code in the error details; do not treat this as a worker code defect or retry blindly.",
    [errorCodes.coreWorkerAssetUnavailable]:
        "The worker binary or asset is not available for the target. Verify the target platform, architecture, and worker artifact; do not keep retrying start or pretend the worker is callable.",
    [errorCodes.coreWorkerHandshakeFailed]:
        "A worker process or transport may be up but the protocol handshake failed. Check worker logs, protocol version, and RPC state; do not classify this as a plain network failure or call tools as if ready.",
    [errorCodes.coreWorkerProvisionFailed]:
        "Provisioning the worker on the target did not complete. Check the target and provider diagnostics; do not continue as though the worker is installed.",
    [errorCodes.coreWorkerRpcDisconnected]:
        "The worker RPC connection dropped, so the final state of any in-flight operation may be unknown. Inspect instance status and the real target state (files, tasks, transfers) before acting; do not immediately repeat an operation that may have side effects.",
    [errorCodes.coreWorkerRpcSpawnFailed]:
        "Spawning the worker RPC process failed. Check the runtime and target environment; do not treat this as a command exit code.",
    [errorCodes.coreWorkerStartFailed]:
        "Starting the worker failed. Check instance_status and provider diagnostics for the real state; do not assume the worker is stopped or running.",
    [errorCodes.coreWorkerStatusFailed]:
        "The worker status could not be confirmed. Do not treat the instance as stopped or running; inspect provider diagnostics and worker logs.",
    [errorCodes.coreWorkerStopFailed]:
        "Stopping the worker failed and its real state may have changed. Call instance_status to confirm; do not claim the worker is stopped or kill an unknown pid.",
    [errorCodes.coreWorkerTargetProbeFailed]:
        "The target could not be confirmed reachable. Check provider connectivity, container, or SSH; do not treat a probe failure as a worker code error.",
    [errorCodes.coreWorkerTargetUnsupported]:
        "The provider or target is not supported. Switch to a supported provider or configuration; do not keep retrying.",
    [errorCodes.reverseSelfManagedOffline]:
        "This is a self-managed reverse instance that must connect from the remote worker. It cannot be started locally; do not apply a controller-managed start workaround.",
    [errorCodes.reverseTransportUnavailable]:
        "The reverse transport is unavailable. Check the remote connection and public endpoint; do not assume RPC is usable.",
    [errorCodes.reverseGenerationInvalid]:
        "The reverse connection generation is invalid. Use the current active generation; do not let a stale connection override a newer one.",
    [errorCodes.reverseConnectionSuperseded]:
        "This reverse connection was superseded by a newer one. Reconnect to obtain the active connection; do not reuse the superseded session.",
    [errorCodes.reverseDeviceCodeInvalid]:
        "The enrollment device code is invalid. Generate a new enrollment code; do not reuse the old one.",
    [errorCodes.reverseDeviceCodeExpired]:
        "The enrollment device code has expired. Generate a new enrollment code; do not reuse the expired one.",
    [errorCodes.reverseDeviceCodeConsumed]:
        "The enrollment device code was already consumed. Generate a new enrollment code; do not reuse it.",
    [errorCodes.reverseDeviceTokenInvalid]:
        "The device token is invalid. Re-enroll or rotate the credential; never echo the token into output.",
    [errorCodes.reverseDeviceTokenRevoked]:
        "The device token was revoked. Re-enroll or rotate the credential; never echo the token into output.",
    [errorCodes.reverseInstanceNotReverse]:
        "This instance is not a reverse instance. Do not use reverse operations on a standard instance.",
    [errorCodes.reverseFrameInvalid]:
        "The connection protocol frame is corrupt. Close and re-establish the connection; do not keep parsing untrusted frames.",
    [errorCodes.streamGap]:
        "The requested event sequence is no longer retained. Fetch a fresh snapshot and resubscribe from its latest sequence; do not treat the missing range as 'no events'.",
    [errorCodes.mcpContextExpired]:
        "The current ctxId has expired. Call environ_info once, adopt the returned ctxId, and keep reusing it for subsequent calls.",
    [errorCodes.mcpContextInvalid]:
        "The ctxId is invalid, missing, or its principal/instance/workspace binding does not match. Stop calling tools and ask the user how to proceed; do not call environ_info yourself or fabricate a ctxId.",
    [errorCodes.targetInvalid]:
        "The requested target is invalid. Provide a valid instance target; do not guess target names.",
    [errorCodes.controlClientIdentityRequired]:
        "A client identity is required for this operation. Supply the required identity; do not proceed unauthenticated.",
    [errorCodes.controlClientIdentityInvalid]:
        "The supplied client identity is invalid. Correct the identity; do not retry with the same value."
};

export function crossToolErrorHints(body: ControlErrorBody): ToolDiagnosticHint[] {
    const hints: ToolDiagnosticHint[] = [];
    let current: ControlErrorBody | undefined = body;
    while (current !== undefined) {
        const text = crossToolHints[current.code];
        if (text !== undefined) {
            hints.push(errorHint(current.code, text));
        }
        current = current.cause;
    }
    return hints;
}

export function hasCrossToolHint(code: string): boolean {
    return crossToolHints[code] !== undefined;
}
