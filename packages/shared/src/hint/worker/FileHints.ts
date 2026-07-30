import type { ControlErrorBody } from "../../error/ErrorBodyControl.js";
import type { JsonValue } from "../../type/TypeJsonValue.js";
import { asArray, asBoolean, asNumber, asRecord, asString } from "../JsonRead.js";
import { diagnosticHint, errorHint, type ToolDiagnosticHint } from "../ToolDiagnosticHint.js";
import { workerCommonErrorHints } from "./WorkerCommonHints.js";

export function fileReadResultHints(result: JsonValue): ToolDiagnosticHint[] {
    const record = asRecord(result);
    if (record === undefined) return [];
    const hints: ToolDiagnosticHint[] = [];

    if (asBoolean(record.truncated) === true) {
        hints.push(diagnosticHint(
            "file.partialRead",
            "Only part of the file was returned. Continue with the returned nextSelector or narrower ranges; do not draw whole-file conclusions from this fragment."
        ));
    }

    if (asString(record.parseStatus) === "partial") {
        hints.push(diagnosticHint(
            "file.partialParse",
            "The outline or structural parse is incomplete. Verify with a content view, file_search, or explicit ranges; do not rely on an incomplete outline for a whole-file refactor."
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
        "More matching entries remain. Continue with the same query and the returned nextCursor; do not claim the results are complete until paging finishes."
    )];
}

export function fileSearchResultHints(result: JsonValue): ToolDiagnosticHint[] {
    const record = asRecord(result);
    if (record === undefined) return [];
    if (asString(record.nextCursor) === undefined) return [];
    return [diagnosticHint(
        "file.partialResults",
        "More search results remain. Continue with the same paths, pattern, context, and the returned nextCursor; do not claim the search is exhausted until paging finishes."
    )];
}

export function fileEditResultHints(result: JsonValue): ToolDiagnosticHint[] {
    const record = asRecord(result);
    if (record === undefined) return [];
    const operations = asArray(record.operations);
    if (operations === undefined) return [];

    if (asBoolean(record.complete) === false) {
        return [partialEditHint(operations)];
    }

    const hints: ToolDiagnosticHint[] = [];
    for (const entry of operations) {
        const op = asRecord(entry);
        if (op === undefined) continue;
        if (asString(op.status) !== "applied") continue;
        const action = asString(op.action);
        if ((action === "patch" || action === "rewrite") &&
            asNumber(op.addedLines) === 0 && asNumber(op.removedLines) === 0) {
            hints.push(diagnosticHint(
                "file.noContentChange",
                "An applied edit produced no content difference. Do not report a substantive modification; verify the target if a change was expected."
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
                "The write succeeded but the returned diff or preview is incomplete. Do not claim to have reviewed the full diff; re-read the affected region to verify."
            ));
            break;
        }
    }
    return hints;
}

function partialEditHint(operations: JsonValue[]): ToolDiagnosticHint {
    let firstFailed: Record<string, JsonValue> | undefined;
    let appliedCount = 0;
    for (const entry of operations) {
        const op = asRecord(entry);
        if (op === undefined) continue;
        const status = asString(op.status);
        if (status === "applied") appliedCount += 1;
        if (status === "failed" && firstFailed === undefined) firstFailed = op;
    }

    const appliedText = appliedCount > 0
        ? `${appliedCount} earlier operation(s) were applied and are already in effect, and operations after the failure were not executed.`
        : "No operation was applied, and operations after the failure were not executed.";
    const failureText = firstFailed === undefined
        ? "The change set did not complete."
        : `The first failure was operation #${asString(firstFailed.index) ?? asNumber(firstFailed.index) ?? "?"} ` +
          `(${asString(firstFailed.action) ?? "unknown"}, code ${failedCode(firstFailed)}).`;

    return errorHint(
        "file.partialEdit",
        `The change set partially failed. ${failureText} ${appliedText} Inspect each operation status, re-read the modified files, and rebuild only the failed and not-executed operations; do not replay the entire original change set unchanged.`
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
                "Use a valid workspace-relative or absolute path. Do not use '..', symlinks, or repeated separators to bypass path rules, and do not guess the target file."
            )];
        case "file.pathEscapesWorkspace":
        case "security.denied":
            return [errorHint(
                body.code,
                "The path is outside the allowed security boundary. Choose a path inside the workspace, or have the user explicitly change the security policy; do not bypass the restriction via symlinks, absolute paths, shell commands, or other tools."
            )];
        case "file.notFound":
            return [errorHint(
                "file.notFound",
                "Confirm the real path with file_info or file_find first. Do not create an empty file to mask a lookup error; only write the file if the user explicitly asked to create it."
            )];
        case "file.notText":
            return [errorHint(
                "file.notText",
                "The file is not valid UTF-8 text, so text tools cannot process it. Do not rewrite it with a text editor or treat this as empty/no-match; use a byte-level path such as artifact base64 if explicitly authorized."
            )];
        case "file.notFile":
            return [errorHint(
                "file.notFile",
                "The target is not a regular file. Use file_find for directories; do not read a directory as a file."
            )];
        case "file.notDirectory":
            return [errorHint(
                "file.notDirectory",
                "The glob root must be a directory. Confirm it with file_info first."
            )];
        case "file.invalidPattern":
            return [errorHint(
                "file.invalidPattern",
                "The glob pattern is invalid. Fix the pattern; do not rely on shell pre-expansion."
            )];
        case "file.invalidRegex":
            return [errorHint(
                "file.invalidRegex",
                "The search pattern failed to compile. Fix the regex or use a literal pattern; do not resubmit the same expression."
            )];
        case "file.invalidCursor":
            return [errorHint(
                "file.invalidCursor",
                "The cursor is expired or does not match the query. Re-run the same query from the first page; do not reuse a cursor across different queries."
            )];
        case "file.invalidRange":
            return [errorHint(
                "file.invalidRange",
                "The requested range is invalid. Provide a valid one-based line range; do not guess at the returned content."
            )];
        case "file.lineTooLarge":
            return [errorHint(
                "file.lineTooLarge",
                "A single line exceeds the output budget. Use a narrower segment or a byte-level read; do not pretend the line was read completely."
            )];
        case "file.outlineTooLarge":
            return [errorHint(
                "file.outlineTooLarge",
                "The outline is too large. Use content ranges or file_search instead."
            )];
        case "file.outlineUnavailable":
        case "file.parseFailed":
            return [errorHint(
                body.code,
                "The outline is unavailable for this file. Do not request the same outline again; use a content view or file_search."
            )];
        case "file.outputTooLarge":
            return [errorHint(
                "file.outputTooLarge",
                "The search output is too large. Narrow the paths, pattern, or context and split the search; do not raise the protocol output limit."
            )];
        case "file.revisionMismatch":
            return [errorHint(
                "file.revisionMismatch",
                "The file changed after it was read or searched. Read the latest content and regenerate the edit or search; do not overwrite or rely on the older revision."
            )];
        case "file.snapshotRequired":
            return [errorHint(
                "file.snapshotRequired",
                "Read or search the exact target within this ctxId before editing it. Do not bypass the snapshot requirement via Rewrite, shell, or other tools."
            )];
        case "file.invalidEdit":
        case "file.invalidPatch":
            return [errorHint(
                body.code,
                "The edit input is malformed and nothing was applied. Fix the edit document and retry; do not claim any operation completed."
            )];
        case "file.emptyOperation":
            return [errorHint(
                "file.emptyOperation",
                "The change set contains an empty operation and nothing was applied. Provide a non-empty operation."
            )];
        case "file.tooManyOperations":
            return [errorHint(
                "file.tooManyOperations",
                "The change set has too many operations and nothing was applied. Split it into smaller change sets."
            )];
        case "file.alreadyExists":
            return [errorHint(
                "file.alreadyExists",
                "The target already exists. Use Patch or Rewrite to modify it, or choose a genuinely new path to create; do not overwrite automatically."
            )];
        case "file.pathConflict":
            return [errorHint(
                "file.pathConflict",
                "Operations in the change set conflict on a path and nothing was applied. Resolve the conflict and regenerate the change set."
            )];
        case "file.parentNotFound":
            return [errorHint(
                "file.parentNotFound",
                "The parent directory does not exist and nothing was applied. Verify the target path; create parent directories only if the user explicitly intends to."
            )];
        case "file.patchOverlap":
            return [errorHint(
                "file.patchOverlap",
                "The patch hunks overlap and nothing was applied. Regenerate non-overlapping hunks against the same original snapshot; do not rely on application order to cover overlapping regions."
            )];
        case "file.patchNotFound":
            return [errorHint(
                "file.patchNotFound",
                "The patch context no longer matches the current snapshot. Re-read the target region and regenerate the hunk; do not repeat the same patch."
            )];
        case "file.patchAmbiguous":
            return [errorHint(
                "file.patchAmbiguous",
                "The patch context matches multiple locations. Add unique surrounding context; do not arbitrarily pick the first match."
            )];
        case "file.unreadRange":
            return [errorHint(
                "file.unreadRange",
                "The edit references lines that were never read. Read the specific missing line ranges, then retry only the failed and not-executed operations; do not expand into an unbounded whole-file overwrite."
            )];
        case "file.crossDeviceMoveUnsupported":
        case "file.atomicMoveUnsupported":
            return [errorHint(
                body.code,
                "Atomic move semantics cannot be guaranteed here. Do not silently downgrade to copy+delete; redesign the move only if the user explicitly accepts the semantic change."
            )];
        case "file.readFailed":
            return [errorHint(
                "file.readFailed",
                "Reading the file failed. Check the path and I/O state and retry; do not assume content."
            )];
        case "file.writeFailed":
            return [errorHint(
                "file.writeFailed",
                "Writing failed. Check the original I/O error, capacity, permissions, and filesystem state; do not run global chmod/chown or claim the write succeeded."
            )];
        case "tool.cancelled":
            return [errorHint(
                "tool.cancelled",
                toolName === "file_edit"
                    ? "The file_edit call was cancelled mid-operation, so earlier operations may already be applied. Treat this as a partial change: inspect operation status and re-read affected files; do not assume cancellation means zero side effects."
                    : "The file call was cancelled before completing. It has no side effects; retry if the result is still needed."
            )];
        default:
            return workerCommonErrorHints(body);
    }
}
