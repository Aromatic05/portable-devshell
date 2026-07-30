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
            "The artifact storage itself reached its cap, so even reaching eof only covers the retained bytes and the original source output beyond them is lost. Do not try to recover the missing data by further paging; re-run the producer with less output, segmented output, or a different approach."
        ));
    }

    if (asBoolean(record.eof) === false && asNumber(record.nextOffsetBytes) !== undefined) {
        hints.push(diagnosticHint(
            "artifact.partialRead",
            "Only part of the artifact was returned. Continue reading with the same handle and the returned nextOffsetBytes; do not claim to have read the full output before reaching eof."
        ));
    }

    if (asBoolean(record.lossy) === true) {
        hints.push(diagnosticHint(
            "artifact.lossy",
            "UTF-8 decoding used replacement characters, so this content is not lossless. Re-read the relevant range with encoding=base64 for exact bytes; do not make byte-level judgments from lossy content."
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
                "This artifact handle is no longer usable. Obtain a fresh artifact from a new tool call; do not keep reading the old handle."
            )];
        case "artifact.invalidOffset":
            return [errorHint(
                "artifact.invalidOffset",
                "The requested byte offset is invalid. Use the totalBytes and nextOffsetBytes reported by the result; do not guess offsets."
            )];
        case "artifact.quotaExceeded":
            return [errorHint(
                "artifact.quotaExceeded",
                "The artifact storage quota is exceeded. Clean up artifacts or reduce output volume; do not keep generating more artifacts."
            )];
        case "artifact.storageFailed":
            return [errorHint(
                "artifact.storageFailed",
                "Artifact storage failed. Do not claim the artifact was persisted; retry the producing call if the output is still needed."
            )];
        case "artifact.readFailed":
            return [errorHint(
                "artifact.readFailed",
                "Reading the artifact failed. Retry the read; if it keeps failing, regenerate the artifact."
            )];
        case "artifact.contentUnavailable":
            return [errorHint(
                "artifact.contentUnavailable",
                "The artifact content is unavailable. Regenerate the artifact from a new tool call; do not fabricate content."
            )];
        case "artifact.invalidLease":
        case "artifact.payloadNotFound":
        case "artifact.payloadExpired":
            return [errorHint(
                body.code,
                "The artifact payload backing this read is no longer valid. Regenerate the artifact; do not retry the same handle."
            )];
        case "tool.cancelled":
            return [errorHint(
                "tool.cancelled",
                "The artifact_read call was cancelled before completing. It has no side effects; retry the read if the content is still needed."
            )];
        default:
            return workerCommonErrorHints(body);
    }
}
