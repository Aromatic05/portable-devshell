import type { ControlErrorBody } from "../../error/ErrorBodyControl.js";
import { errorHint, type ToolDiagnosticHint } from "../ToolDiagnosticHint.js";

export function todoErrorHints(body: ControlErrorBody): ToolDiagnosticHint[] {
    switch (body.code) {
        case "todo.revisionConflict":
            return [errorHint(
                "todo.revisionConflict",
                "The write was not applied because the revision is stale. Call todo_read for the same exact title, merge any concurrent changes, and resubmit the complete replacement list with the latest revision; do not overwrite with the old revision."
            )];
        case "todo.invalid":
            return [errorHint(
                "todo.invalid",
                "The todo write was rejected as invalid. Check the error details for the specific violated invariant (valid revision, non-empty title, todos as an array, unique ids, non-empty content, valid status, at most one in_progress, and a detail required for blocked or failed). todo_write is a full replacement, not a patch; resubmit the complete corrected list, not just the failing item."
            )];
        default:
            return [];
    }
}
