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
            "The transfer was accepted but has not completed. Poll artifact_transfer with operation=status using this transferId; do not report delivery yet or start a duplicate transfer."
        )];
    }

    if (nonTerminalInProgress.has(status)) {
        return [diagnosticHint(
            "artifact.transferInProgress",
            "The transfer has not reached a terminal state. Keep querying with the same transferId; do not report completion or start a duplicate transfer."
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
            "The transfer was terminated as interrupted, usually by a control restart or shutdown, and will not recover on its own. Inspect source and target state; if the transfer is still needed, create a new one. Do not keep polling the old transferId."
        )];
    }

    if (status === "cancelled") {
        return [errorHint(
            "artifact.transferCancelled",
            "The transfer was cancelled and did not complete. Do not report it as delivered; if cancellation happened mid-processing, check the target for temporary or committed state. Do not automatically restart it."
        )];
    }

    return [];
}

function cancelHints(status: string): ToolDiagnosticHint[] {
    if (status === "completed") {
        return [diagnosticHint(
            "artifact.transferCancelCompleted",
            "Cancelling did not undo a completed transfer; the target content still exists. Cancel only stops work that has not finished."
        )];
    }
    if (status === "cancelled") {
        return [diagnosticHint(
            "artifact.transferCancelAlready",
            "The transfer was already cancelled; this cancel did not change its state."
        )];
    }
    if (status === "failed" || status === "interrupted") {
        return [diagnosticHint(
            "artifact.transferCancelTerminal",
            `The transfer had already terminated as ${status}; this cancel did not change its state. Inspect source and target before any new transfer.`
        )];
    }
    return [];
}

function transferFailureHint(transfer: Record<string, JsonValue>): ToolDiagnosticHint {
    const failure = asRecord(transfer.failure);
    const code = asString(failure?.code);
    const base = "The transfer terminated as failed; do not keep polling it to become completed. Inspect source and target state before any new transfer, and do not restart with overwrite=true without explicit authorization.";
    switch (code) {
        case "artifact.targetExists":
            return errorHint(
                "artifact.targetExists",
                "The target already exists and overwrite is off. Do not set overwrite=true without explicit user authorization; verify the target path before retrying."
            );
        case "artifact.payloadInvalid":
            return errorHint(
                "artifact.payloadInvalid",
                "The payload failed verification. Do not trust the target content; check the source, transport, and target. Do not resolve this by disabling verification."
            );
        case "artifact.receiveOffsetMismatch":
            return errorHint(
                "artifact.receiveOffsetMismatch",
                "A chunk offset mismatch occurred. Do not skip or duplicate chunks; start a new transfer rather than manually continuing the old receive id."
            );
        case "artifact.directoryChanged":
            return errorHint(
                "artifact.directoryChanged",
                "The source directory changed during snapshot or archive. Stabilize the source and create a new transfer; do not treat an inconsistent archive as valid."
            );
        case "artifact.directoryUnsafe":
            return errorHint(
                "artifact.directoryUnsafe",
                "The source directory failed safety checks (symlink, path traversal, duplicate, or unsupported entry). Fix the source tree; do not bypass the safety checks."
            );
        case "artifact.commitFailed":
            return errorHint(
                "artifact.commitFailed",
                "The final commit failed, so the target state may be partial. Inspect the target; do not report 'no impact' or automatically delete or overwrite the target."
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
                "The image format is not supported (only PNG, JPEG, GIF, and WebP). Convert to a supported format and retry; do not fake the media type from the file extension."
            )];
        case "artifact.imageTooLarge":
            return [errorHint(
                "artifact.imageTooLarge",
                "The image exceeds the 10 MiB limit. Shrink or convert the image; do not raise the protocol limit or pass off a truncated image as complete."
            )];
        case "artifact.payloadInvalid":
            return [errorHint(
                "artifact.payloadInvalid",
                "The image payload is invalid (chunk metadata, base64, length, or hash mismatch). Do not display or trust the partial image; re-obtain the source payload and check the worker/transport."
            )];
        case "artifact.contentUnavailable":
            return [errorHint(
                "artifact.contentUnavailable",
                "The artifact content is unavailable. Re-create the source artifact; do not fabricate content."
            )];
        case "artifact.expired":
        case "artifact.notFound":
            return [errorHint(
                body.code,
                "The artifact is no longer available. Produce a fresh artifact and retry; do not reuse the stale handle."
            )];
        case "artifact.shareNotFound":
        case "artifact.shareRevoked":
        case "artifact.shareExpired":
            return [errorHint(
                body.code,
                "The share link is no longer usable and cannot be restored. If sharing is still needed, create a new share; do not reuse the old token."
            )];
        case "artifact.directoryUnsafe":
            return [errorHint(
                "artifact.directoryUnsafe",
                "The directory failed safety checks (symlink, non-regular entry, non-UTF-8 or escaping path, or unsupported entry). Fix the source tree; do not follow symlinks or lower the archive safety checks."
            )];
        case "artifact.storageFailed":
            return [errorHint(
                "artifact.storageFailed",
                "Artifact storage failed. Do not claim the artifact was persisted; retry the operation."
            )];
        case "artifact.transferNotFound":
            return [errorHint(
                "artifact.transferNotFound",
                "The transfer id was not found. Use the transferId returned by operation=start; do not construct or guess ids."
            )];
        case "artifact.transferInterrupted":
            return [errorHint(
                "artifact.transferInterrupted",
                "The transfer was interrupted and will not resume. Inspect source and target, then create a new transfer if needed; do not keep querying the old transferId."
            )];
        case "artifact.transferStateConflict":
            return [errorHint(
                "artifact.transferStateConflict",
                "The transfer operation conflicts with the transfer's current state. Re-query the transfer status and issue a consistent operation."
            )];
        case "artifact.hostPathDenied":
            return [errorHint(
                "artifact.hostPathDenied",
                "The host path is not allowed for this artifact operation. Choose an allowed path; do not bypass the path policy."
            )];
        case "core.toolCallCancelled":
            return [errorHint(
                "core.toolCallCancelled",
                "The artifact operation was cancelled. A view or read has no lasting effect; do not treat partially read content as a complete image. A start or cancel may have changed transfer state, so re-query the transfer before acting."
            )];
        default:
            return [];
    }
}
