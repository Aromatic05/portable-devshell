import type { ControlErrorBody } from "../../error/ErrorBodyControl.js";
import type { JsonValue } from "../../type/TypeJsonValue.js";
import { asArray, asBoolean, asNumber, asRecord, asString } from "../JsonRead.js";
import { diagnosticHint, errorHint, type ToolDiagnosticHint } from "../ToolDiagnosticHint.js";
import { workerCommonErrorHints } from "./WorkerCommonHints.js";

export function fileReadResultHints(result: JsonValue): ToolDiagnosticHint[] {
    const record = asRecord(result);
    if (record === undefined) return [];
    const hints: ToolDiagnosticHint[] = [];

    if (asString(record.nextSelector) !== undefined || asBoolean(record.truncated) === true) {
        hints.push(diagnosticHint(
            "file.partialRead",
            "Continue with nextSelector."
        ));
    }

    if (asString(record.parseStatus) === "partial") {
        hints.push(diagnosticHint(
            "file.partialParse",
            "Verify with content view or file_search."
        ));
    }

    return hints;
}

export function fileFindResultHints(result: JsonValue): ToolDiagnosticHint[] {
    const record = asRecord(result);
    if (record === undefined) return [];
    if (asString(record.nextCursor) === undefined) return [];
    return [diagnosticHint(
        "file.partialResults",
        "Continue with nextCursor."
    )];
}

export function fileSearchResultHints(result: JsonValue): ToolDiagnosticHint[] {
    const record = asRecord(result);
    if (record === undefined) return [];
    if (asString(record.nextCursor) === undefined) return [];
    return [diagnosticHint(
        "file.partialResults",
        "Continue with nextCursor."
    )];
}

export function fileEditResultHints(result: JsonValue): ToolDiagnosticHint[] {
    const record = asRecord(result);
    if (record === undefined) return [];
    const operations = asArray(record.operations);
    if (operations === undefined) return [];

    if (operations.some((entry) => asString(asRecord(entry)?.status) === "failed")) {
        return [partialEditHint(operations)];
    }

    const hints: ToolDiagnosticHint[] = [];
    for (const entry of operations) {
        const op = asRecord(entry);
        if (op === undefined) continue;
        if (asString(op.status) !== "applied") continue;
        const action = asString(op.action);
        const addedLines = asNumber(op.addedLines);
        const removedLines = asNumber(op.removedLines);
        const noContentChange =
            (addedLines === undefined && removedLines === undefined) ||
            (addedLines === 0 && removedLines === 0);
        if ((action === "patch" || action === "rewrite") && noContentChange) {
            hints.push(diagnosticHint(
                "file.noContentChange",
                "No content changed."
            ));
            break;
        }
    }
    for (const entry of operations) {
        const op = asRecord(entry);
        if (op === undefined) continue;
        if (asString(op.status) === "applied" && asBoolean(op.truncated) === true) {
            hints.push(diagnosticHint(
                "file.diffTruncated",
                "Re-read the affected region."
            ));
            break;
        }
    }
    return hints;
}

function partialEditHint(operations: JsonValue[]): ToolDiagnosticHint {
    let firstFailed: Record<string, JsonValue> | undefined;
    let firstFailedIndex: number | undefined;
    let appliedCount = 0;
    for (const [index, entry] of operations.entries()) {
        const op = asRecord(entry);
        if (op === undefined) continue;
        const status = asString(op.status);
        if (status === "applied") appliedCount += 1;
        if (status === "failed" && firstFailed === undefined) {
            firstFailed = op;
            firstFailedIndex = asNumber(op.index) ?? index + 1;
        }
    }

    const failure = firstFailed === undefined
        ? "unknown failure"
        : `operation #${firstFailedIndex ?? "?"} (${asString(firstFailed.action) ?? "unknown"}, ${failedCode(firstFailed)})`;
    return errorHint(
        "file.partialEdit",
        `${failure}; ${appliedCount} earlier operation(s) applied. Retry only failed and skipped operations.`
    );
}

function failedCode(op: Record<string, JsonValue>): string {
    const error = asRecord(op.error);
    return asString(error?.code) ?? "unknown";
}

export function fileErrorHints(toolName: string, body: ControlErrorBody): ToolDiagnosticHint[] {
    switch (body.code) {
        case "file.invalidPath":
            return [errorHint(
                "file.invalidPath",
                "Use a valid canonical path."
            )];
        case "file.pathEscapesWorkspace":
        case "security.denied":
            return [errorHint(
                body.code,
                "Use a path allowed by the security policy."
            )];
        case "file.notFound":
            return [errorHint(
                "file.notFound",
                "Confirm the path with file_info or file_find."
            )];
        case "file.notText":
            return [errorHint(
                "file.notText",
                "Use a byte-level tool for this file."
            )];
        case "file.notFile":
            return [errorHint(
                "file.notFile",
                "Use file_find for directories."
            )];
        case "file.notDirectory":
            return [errorHint(
                "file.notDirectory",
                "Confirm the directory with file_info."
            )];
        case "file.invalidPattern":
            return [errorHint(
                "file.invalidPattern",
                "Fix the glob pattern."
            )];
        case "file.invalidRegex":
            return [errorHint(
                "file.invalidRegex",
                "Fix the regex or use literal syntax."
            )];
        case "file.invalidCursor":
            return [errorHint(
                "file.invalidCursor",
                "Restart the same query without a cursor."
            )];
        case "file.invalidRange":
            return [errorHint(
                "file.invalidRange",
                "Use a valid one-based line range."
            )];
        case "file.lineTooLarge":
            return [errorHint(
                "file.lineTooLarge",
                "Use a narrower or byte-level read."
            )];
        case "file.outlineTooLarge":
            return [errorHint(
                "file.outlineTooLarge",
                "Use content ranges or file_search."
            )];
        case "file.outlineUnavailable":
        case "file.parseFailed":
            return [errorHint(
                body.code,
                "Use content view or file_search."
            )];
        case "file.outputTooLarge":
            return [errorHint(
                "file.outputTooLarge",
                "Narrow the search."
            )];
        case "file.revisionMismatch":
            return [errorHint(
                "file.revisionMismatch",
                "Read the latest content and regenerate the operation."
            )];
        case "file.snapshotRequired":
            return [errorHint(
                "file.snapshotRequired",
                "Read or search the target before editing."
            )];
        case "file.invalidEdit":
        case "file.invalidPatch":
            return [errorHint(
                body.code,
                "Fix the edit document."
            )];
        case "file.literalDiffBody":
            return [errorHint(
                "file.literalDiffBody",
                "Rejected: no diff or diff-like content. Write File and Rewrite File take literal content; `+`/`-` prefixes belong to Patch File. Output plain text."
            )];
        case "file.emptyOperation":
            return [errorHint(
                "file.emptyOperation",
                "Provide a non-empty operation."
            )];
        case "file.tooManyOperations":
            return [errorHint(
                "file.tooManyOperations",
                "Split the change set."
            )];
        case "file.alreadyExists":
            return [errorHint(
                "file.alreadyExists",
                "Do not overwrite; use an explicitly requested action."
            )];
        case "file.pathConflict":
            return [errorHint(
                "file.pathConflict",
                "Resolve conflicting path operations."
            )];
        case "file.parentNotFound":
            return [errorHint(
                "file.parentNotFound",
                "Create the parent only if explicitly requested."
            )];
        case "file.patchOverlap":
            return [errorHint(
                "file.patchOverlap",
                "Regenerate non-overlapping hunks."
            )];
        case "file.patchNotFound":
            return [errorHint(
                "file.patchNotFound",
                "Re-read the region and regenerate the hunk."
            )];
        case "file.patchAmbiguous":
            return [errorHint(
                "file.patchAmbiguous",
                "Add unique patch context."
            )];
        case "file.unreadRange":
            return [errorHint(
                "file.unreadRange",
                "Read the missing ranges, then retry failed operations."
            )];
        case "file.crossDeviceMoveUnsupported":
        case "file.atomicMoveUnsupported":
            return [errorHint(
                body.code,
                "Choose a target supporting atomic move."
            )];
        case "file.readFailed":
            return [errorHint(
                "file.readFailed",
                "Check the path and I/O state."
            )];
        case "file.writeFailed":
            return [errorHint(
                "file.writeFailed",
                "Inspect the write error and filesystem state."
            )];
        case "tool.cancelled":
            return [errorHint(
                "tool.cancelled",
                toolName === "file_edit"
                    ? "Partial change possible; re-read affected files."
                    : "Retry if the result is still needed."
            )];
        default:
            return workerCommonErrorHints(body);
    }
}
