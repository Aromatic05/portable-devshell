import type { ControlErrorBody } from "../../error/ErrorBodyControl.js";
import { errorHint, type ToolDiagnosticHint } from "../ToolDiagnosticHint.js";

export function workerCommonErrorHints(body: ControlErrorBody): ToolDiagnosticHint[] {
    switch (body.code) {
        case "tool.invalidArguments":
            return [errorHint(
                "tool.invalidArguments",
                "The tool arguments failed validation and the call did not execute. Correct the arguments against the tool schema; do not retry with the same input."
            )];
        case "tool.internalError":
            return [errorHint(
                "tool.internalError",
                "The tool hit an internal error and did not produce a reliable result. Inspect the worker state before retrying; do not report completion."
            )];
        case "tool.notFound":
            return [errorHint(
                "tool.notFound",
                "The requested tool is not registered on this worker. Check the tool name and instance capability; do not guess alternative tool names."
            )];
        default:
            return [];
    }
}
