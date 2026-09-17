import type { ControlErrorBody } from "@portable-devshell/shared";
import { errorHint, type ToolDiagnosticHint } from "../Hint.js";

export function workerCommonErrorHints(
    body: ControlErrorBody,
): ToolDiagnosticHint[] {
    switch (body.code) {
        case "tool.invalidArguments":
            return [
                errorHint(
                    "tool.invalidArguments",
                    "Correct the arguments against the schema.",
                ),
            ];
        case "tool.internalError":
            return [
                errorHint(
                    "tool.internalError",
                    "Inspect worker state before retrying.",
                ),
            ];
        case "tool.notFound":
            return [
                errorHint(
                    "tool.notFound",
                    "Check the tool name and worker capability.",
                ),
            ];
        default:
            return [];
    }
}
