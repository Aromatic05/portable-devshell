import type { ControlErrorBody } from "@portable-devshell/shared";
import { errorHint, type ToolDiagnosticHint } from "../Hint.js";

const crossToolHints: Record<string, string> = {
    "core.toolSchedulerFull": "Wait for tool capacity.",
    "core.toolQueueTimeout": "Retry after capacity frees.",
    "core.toolCallCancelled":
        "Call cancelled; verify whether it started.",
    "core.approvalRequired": "Wait for user approval.",
    "core.approvalDenied": "Do not retry without a new user request.",
    "core.approvalExpired": "Request fresh approval.",
    "core.approvalNotFound": "Refresh approval state.",
    "core.approvalAlreadyDecided": "Refresh approval state.",
    "core.approvalPolicyInvalid": "Fix the approval policy.",
    "core.toolSchemaUnavailable":
        "Check tool policy and instance readiness.",
    "mcp.toolSchemaUnavailable": "Check instance readiness and capability.",
    "core.instanceNotReady": "Run devshell instance status.",
    "core.instanceBusy": "Wait, then run devshell instance status.",
    "core.providerFailed": "Inspect provider diagnostics.",
    "core.workerAssetUnavailable":
        "Verify the target platform and worker asset.",
    "core.workerHandshakeFailed":
        "Check worker logs and protocol version.",
    "core.workerProvisionFailed": "Inspect provisioning diagnostics.",
    "core.workerRpcDisconnected":
        "Verify target state before retrying.",
    "core.workerRpcSpawnFailed": "Check the worker runtime.",
    "core.workerStartFailed":
        "Run devshell instance status and inspect provider diagnostics.",
    "core.workerStatusFailed":
        "Inspect provider diagnostics and worker logs.",
    "core.workerStopFailed":
        "Confirm state with devshell instance status.",
    "core.workerTargetProbeFailed": "Check provider connectivity.",
    "core.workerTargetUnsupported":
        "Use a supported provider or target.",
    "reverse.selfManagedLifecycle":
        "Start or stop the worker on the remote machine.",
    "reverse.selfManagedOffline":
        "Wait for the remote worker to connect.",
    "reverse.transportUnavailable": "Check the reverse connection.",
    "reverse.generationInvalid":
        "Use the current connection generation.",
    "reverse.connectionSuperseded":
        "Reconnect with the active session.",
    "reverse.deviceCodeInvalid": "Generate a new enrollment code.",
    "reverse.deviceCodeExpired": "Generate a new enrollment code.",
    "reverse.deviceCodeConsumed": "Generate a new enrollment code.",
    "reverse.deviceTokenInvalid":
        "Re-enroll or rotate the credential.",
    "reverse.deviceTokenRevoked":
        "Re-enroll or rotate the credential.",
    "reverse.instanceNotReverse":
        "Use reverse operations only on reverse instances.",
    "reverse.frameInvalid": "Reconnect the reverse transport.",
    "stream.gap": "Fetch a fresh snapshot and resubscribe.",
    "mcp.contextExpired":
        "Call environ_info to renew the current Context, adding workspace only if it is not already attached.",
    "mcp.contextDisabled":
        "Call environ_info with workspace to establish a new active Context.",
    "mcp.contextInstanceMasked":
        "This instance is permanently unavailable for the lifetime of the current Context; do not retry or attempt to unmask it.",
    "mcp.contextInvalid":
        "Call environ_info with workspace to establish or recover the current Context.",
    "mcp.contextWorkspaceRequired":
        "Obtain the instance handle with devshell instance list/status, then use environ_remote command='attach' with an absolute workspace.",
    "control.invalidTarget": "Use a valid instance target.",
    "control.clientIdentityRequired":
        "Supply the required client identity.",
    "control.clientIdentityInvalid": "Correct the client identity.",
    "control.modelReplyRequired":
        "Call todo_report before using more tools.",
    "control.modelResumed":
        "Read the resumed user instruction before deciding the next action.",
    "control.modelStopped":
        "Do not call tools until the user sends #resume.",
};

export function crossToolErrorHints(
    body: ControlErrorBody,
): ToolDiagnosticHint[] {
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

export function workerErrorHints(
    body: ControlErrorBody,
): ToolDiagnosticHint[] {
    switch (body.code) {
        case "tool.invalidArguments":
            return [
                errorHint(
                    "tool.invalidArguments",
                    "Correct the arguments against the schema.",
                ),
            ];
        case "tool.internalError":
            return [
                errorHint(
                    "tool.internalError",
                    "Inspect worker state before retrying.",
                ),
            ];
        case "tool.notFound":
            return [
                errorHint(
                    "tool.notFound",
                    "Check the tool name and worker capability.",
                ),
            ];
        default:
            return [];
    }
}
