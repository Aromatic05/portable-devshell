import type { ControlErrorBody } from "../../error/ErrorBodyControl.js";
import type { JsonValue } from "../../type/TypeJsonValue.js";
import { asBoolean, asNumber, asRecord } from "../JsonRead.js";
import { diagnosticHint, errorHint, type ToolDiagnosticHint } from "../ToolDiagnosticHint.js";
import { workerCommonErrorHints } from "./WorkerCommonHints.js";

export function artifactReadResultHints(result: JsonValue): ToolDiagnosticHint[] {
    const record = asRecord(result);
    if (record === undefined) return [];
    const hints: ToolDiagnosticHint[] = [];

    if (asBoolean(record.artifactTruncated) === true) {
        hints.push(diagnosticHint(
            "artifact.sourceTruncated",
            "Source bytes beyond the artifact cap are unavailable."
        ));
    }

    if (asBoolean(record.eof) === false && asNumber(record.nextOffsetBytes) !== undefined) {
        hints.push(diagnosticHint(
            "artifact.partialRead",
            "Continue with nextOffsetBytes."
        ));
    }

    if (asBoolean(record.lossy) === true) {
        hints.push(diagnosticHint(
            "artifact.lossy",
            "Use base64 for exact bytes."
        ));
    }

    return hints;
}

export function artifactReadErrorHints(body: ControlErrorBody): ToolDiagnosticHint[] {
    switch (body.code) {
        case "artifact.expired":
        case "artifact.notFound":
        case "artifact.invalidHandle":
        case "artifact.leaseNotFound":
            return [errorHint(
                body.code,
                "Obtain a fresh artifact handle."
            )];
        case "artifact.invalidOffset":
            return [errorHint(
                "artifact.invalidOffset",
                "Use a reported byte offset."
            )];
        case "artifact.quotaExceeded":
            return [errorHint(
                "artifact.quotaExceeded",
                "Reduce artifact volume or clean up storage."
            )];
        case "artifact.storageFailed":
            return [errorHint(
                "artifact.storageFailed",
                "Regenerate the artifact if needed."
            )];
        case "artifact.readFailed":
            return [errorHint(
                "artifact.readFailed",
                "Retry or regenerate the artifact."
            )];
        case "artifact.contentUnavailable":
            return [errorHint(
                "artifact.contentUnavailable",
                "Regenerate the artifact."
            )];
        case "artifact.invalidLease":
        case "artifact.payloadNotFound":
        case "artifact.payloadExpired":
            return [errorHint(
                body.code,
                "Regenerate the artifact payload."
            )];
        case "tool.cancelled":
            return [errorHint(
                "tool.cancelled",
                "Retry the read if still needed."
            )];
        default:
            return workerCommonErrorHints(body);
    }
}
