import type { ControlErrorBody } from "../../error/ErrorBodyControl.js";
import type { JsonValue } from "../../type/TypeJsonValue.js";
import { asRecord, asString } from "../JsonRead.js";
import { diagnosticHint, errorHint, type ToolDiagnosticHint } from "../ToolDiagnosticHint.js";

const nonTerminalInProgress = new Set([
    "preparing",
    "transferring",
    "verifying",
    "committing",
    "cancelling"
]);

export function artifactTransferResultHints(result: JsonValue): ToolDiagnosticHint[] {
    const record = asRecord(result);
    if (record === undefined) return [];
    const transfer = asRecord(record.transfer);
    if (transfer === undefined) return [];
    const status = asString(transfer.status);
    if (status === undefined) return [];
    const operation = asString(record.operation);

    if (operation === "cancel") {
        return cancelHints(status);
    }

    if (status === "queued") {
        return [diagnosticHint(
            "artifact.transferQueued",
            "Poll status with the same transferId."
        )];
    }

    if (nonTerminalInProgress.has(status)) {
        return [diagnosticHint(
            "artifact.transferInProgress",
            "Poll status with the same transferId."
        )];
    }

    if (status === "completed") {
        return [];
    }

    if (status === "failed") {
        return [transferFailureHint(transfer)];
    }

    if (status === "interrupted") {
        return [errorHint(
            "artifact.transferInterrupted",
            "Inspect source and target, then start a new transfer."
        )];
    }

    if (status === "cancelled") {
        return [errorHint(
            "artifact.transferCancelled",
            "Check target state before restarting."
        )];
    }

    return [];
}

function cancelHints(status: string): ToolDiagnosticHint[] {
    if (status === "completed") {
        return [diagnosticHint(
            "artifact.transferCancelCompleted",
            "Transfer already completed; target remains."
        )];
    }
    if (status === "cancelled") {
        return [diagnosticHint(
            "artifact.transferCancelAlready",
            "Transfer was already cancelled."
        )];
    }
    if (status === "failed" || status === "interrupted") {
        return [diagnosticHint(
            "artifact.transferCancelTerminal",
            `Transfer already ${status}; cancel changed nothing.`
        )];
    }
    return [];
}

function transferFailureHint(transfer: Record<string, JsonValue>): ToolDiagnosticHint {
    const failure = asRecord(transfer.failure);
    const code = asString(failure?.code);
    const base = "Inspect source and target before retrying.";
    switch (code) {
        case "artifact.targetExists":
            return errorHint(
                "artifact.targetExists",
                "Verify the target before enabling overwrite."
            );
        case "artifact.payloadInvalid":
            return errorHint(
                "artifact.payloadInvalid",
                "Check source, transport, and target integrity."
            );
        case "artifact.receiveOffsetMismatch":
            return errorHint(
                "artifact.receiveOffsetMismatch",
                "Start a new transfer."
            );
        case "artifact.directoryChanged":
            return errorHint(
                "artifact.directoryChanged",
                "Stabilize the source and restart the transfer."
            );
        case "artifact.directoryUnsafe":
            return errorHint(
                "artifact.directoryUnsafe",
                "Fix unsafe source entries."
            );
        case "artifact.commitFailed":
            return errorHint(
                "artifact.commitFailed",
                "Inspect the possibly partial target."
            );
        default:
            return errorHint(
                code ?? "artifact.transferFailed",
                `${base}${code === undefined ? "" : ` Failure code: ${code}.`}`
            );
    }
}

export function artifactControlErrorHints(body: ControlErrorBody): ToolDiagnosticHint[] {
    switch (body.code) {
        case "artifact.imageUnsupported":
            return [errorHint(
                "artifact.imageUnsupported",
                "Convert to PNG, JPEG, GIF, or WebP."
            )];
        case "artifact.imageTooLarge":
            return [errorHint(
                "artifact.imageTooLarge",
                "Reduce the image below 10 MiB."
            )];
        case "artifact.payloadInvalid":
            return [errorHint(
                "artifact.payloadInvalid",
                "Re-obtain and verify the image payload."
            )];
        case "artifact.contentUnavailable":
            return [errorHint(
                "artifact.contentUnavailable",
                "Re-create the source artifact."
            )];
        case "artifact.expired":
        case "artifact.notFound":
            return [errorHint(
                body.code,
                "Produce a fresh artifact."
            )];
        case "artifact.shareNotFound":
        case "artifact.shareRevoked":
        case "artifact.shareExpired":
            return [errorHint(
                body.code,
                "Create a new share link."
            )];
        case "artifact.directoryUnsafe":
            return [errorHint(
                "artifact.directoryUnsafe",
                "Fix unsafe directory entries."
            )];
        case "artifact.storageFailed":
            return [errorHint(
                "artifact.storageFailed",
                "Retry after checking artifact storage."
            )];
        case "artifact.transferNotFound":
            return [errorHint(
                "artifact.transferNotFound",
                "Use the transferId returned by start."
            )];
        case "artifact.transferInterrupted":
            return [errorHint(
                "artifact.transferInterrupted",
                "Inspect state, then create a new transfer."
            )];
        case "artifact.transferStateConflict":
            return [errorHint(
                "artifact.transferStateConflict",
                "Re-query status before the next operation."
            )];
        case "artifact.hostPathDenied":
            return [errorHint(
                "artifact.hostPathDenied",
                "Choose an allowed host path."
            )];
        case "core.toolCallCancelled":
            return [errorHint(
                "core.toolCallCancelled",
                "Re-query transfer state after cancellation."
            )];
        default:
            return [];
    }
}
