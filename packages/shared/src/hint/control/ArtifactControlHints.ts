import type { ControlErrorBody } from "../../error/ErrorBodyControl.js";
import { errorHint, type ToolDiagnosticHint } from "../ToolDiagnosticHint.js";

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
        case "artifact.shareExhausted":
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
                "Inspect state before deciding whether to restart."
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
