import type { ControlErrorBody } from "@portable-devshell/shared";
import { errorHint, type ToolDiagnosticHint } from "../../Hint.js";

export function todoErrorHints(body: ControlErrorBody): ToolDiagnosticHint[] {
    switch (body.code) {
        case "todo.revisionConflict":
            return [
                errorHint(
                    "todo.revisionConflict",
                    "Read the latest revision and resubmit the full plan.",
                ),
            ];
        case "todo.invalid":
            return [
                errorHint(
                    "todo.invalid",
                    todoInvalidAction(body) === "use_other_tools"
                        ? "Use other tools."
                        : "Fix the reported invariant and resubmit the full plan.",
                ),
            ];
        default:
            return [];
    }
}

function todoInvalidAction(body: ControlErrorBody): string | undefined {
    if (
        typeof body.details !== "object" ||
        body.details === null ||
        Array.isArray(body.details)
    )
        return undefined;
    return typeof body.details.action === "string"
        ? body.details.action
        : undefined;
}
