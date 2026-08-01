import type { ControlErrorBody } from "../../error/ErrorBodyControl.js";
import { errorHint, type ToolDiagnosticHint } from "../ToolDiagnosticHint.js";

export function todoErrorHints(body: ControlErrorBody): ToolDiagnosticHint[] {
    switch (body.code) {
        case "todo.revisionConflict":
            return [errorHint(
                "todo.revisionConflict",
                "Read the latest revision and resubmit the full plan."
            )];
        case "todo.invalid":
            return [errorHint(
                "todo.invalid",
                "Fix the reported invariant and resubmit the full plan."
            )];
        default:
            return [];
    }
}
