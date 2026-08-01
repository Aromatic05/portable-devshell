import type { ControlErrorBody } from "../error/ErrorBodyControl.js";
import { errorCodes } from "../error/ErrorCodeCatalog.js";
import { errorHint, type ToolDiagnosticHint } from "./ToolDiagnosticHint.js";

const crossToolHints: Record<string, string> = {
    [errorCodes.coreToolSchedulerFull]: "Wait for tool capacity.",
    [errorCodes.coreToolQueueTimeout]: "Retry after capacity frees.",
    [errorCodes.coreToolCallCancelled]: "Call cancelled; verify whether it started.",
    [errorCodes.coreApprovalRequired]: "Wait for user approval.",
    [errorCodes.coreApprovalDenied]: "Do not retry without a new user request.",
    [errorCodes.coreApprovalExpired]: "Request fresh approval.",
    [errorCodes.coreApprovalNotFound]: "Refresh approval state.",
    [errorCodes.coreApprovalAlreadyDecided]: "Refresh approval state.",
    [errorCodes.coreApprovalPolicyInvalid]: "Fix the approval policy.",
    [errorCodes.coreToolSchemaUnavailable]: "Check tool policy and instance readiness.",
    "mcp.toolSchemaUnavailable": "Check instance readiness and capability.",
    [errorCodes.coreInstanceNotReady]: "Check instance_status.",
    [errorCodes.coreInstanceBusy]: "Wait, then check instance_status.",
    [errorCodes.coreProviderFailed]: "Inspect provider diagnostics.",
    [errorCodes.coreWorkerAssetUnavailable]: "Verify the target platform and worker asset.",
    [errorCodes.coreWorkerHandshakeFailed]: "Check worker logs and protocol version.",
    [errorCodes.coreWorkerProvisionFailed]: "Inspect provisioning diagnostics.",
    [errorCodes.coreWorkerRpcDisconnected]: "Verify target state before retrying.",
    [errorCodes.coreWorkerRpcSpawnFailed]: "Check the worker runtime.",
    [errorCodes.coreWorkerStartFailed]: "Check instance_status and provider diagnostics.",
    [errorCodes.coreWorkerStatusFailed]: "Inspect provider diagnostics and worker logs.",
    [errorCodes.coreWorkerStopFailed]: "Confirm state with instance_status.",
    [errorCodes.coreWorkerTargetProbeFailed]: "Check provider connectivity.",
    [errorCodes.coreWorkerTargetUnsupported]: "Use a supported provider or target.",
    [errorCodes.reverseSelfManagedOffline]: "Wait for the remote worker to connect.",
    [errorCodes.reverseTransportUnavailable]: "Check the reverse connection.",
    [errorCodes.reverseGenerationInvalid]: "Use the current connection generation.",
    [errorCodes.reverseConnectionSuperseded]: "Reconnect with the active session.",
    [errorCodes.reverseDeviceCodeInvalid]: "Generate a new enrollment code.",
    [errorCodes.reverseDeviceCodeExpired]: "Generate a new enrollment code.",
    [errorCodes.reverseDeviceCodeConsumed]: "Generate a new enrollment code.",
    [errorCodes.reverseDeviceTokenInvalid]: "Re-enroll or rotate the credential.",
    [errorCodes.reverseDeviceTokenRevoked]: "Re-enroll or rotate the credential.",
    [errorCodes.reverseInstanceNotReverse]: "Use reverse operations only on reverse instances.",
    [errorCodes.reverseFrameInvalid]: "Reconnect the reverse transport.",
    [errorCodes.streamGap]: "Fetch a fresh snapshot and resubscribe.",
    [errorCodes.mcpContextExpired]: "Call environ_info and use its new ctxId.",
    [errorCodes.mcpContextInvalid]: "Stop and ask the user; do not create a ctxId.",
    [errorCodes.targetInvalid]: "Use a valid instance target.",
    [errorCodes.controlClientIdentityRequired]: "Supply the required client identity.",
    [errorCodes.controlClientIdentityInvalid]: "Correct the client identity."
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
