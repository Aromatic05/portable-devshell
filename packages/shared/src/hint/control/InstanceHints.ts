import type { ControlErrorBody } from "../../error/ErrorBodyControl.js";
import { asRecord, asString } from "../JsonRead.js";
import { errorHint, type ToolDiagnosticHint } from "../ToolDiagnosticHint.js";

export function instanceErrorHints(body: ControlErrorBody): ToolDiagnosticHint[] {
    switch (body.code) {
        case "control.instanceAlreadyExists":
            return [errorHint(
                "control.instanceAlreadyExists",
                "Reuse it or choose another name explicitly."
            )];
        case "control.instanceNotFound":
            return [errorHint(
                "control.instanceNotFound",
                "Check instance_list for a valid name."
            )];
        case "instance.conflict":
            return [errorHint(
                "instance.conflict",
                "Check instance_status before retrying."
            )];
        case "control.configInvalid":
            return [errorHint(
                "control.configInvalid",
                configInvalidDetail(body)
            )];
        case "control.configValidationFailed":
            return [errorHint(
                "control.configValidationFailed",
                "Fix the reported configuration fields."
            )];
        default:
            return [];
    }
}

function configInvalidDetail(body: ControlErrorBody): string {
    const details = asRecord(body.details);
    const fieldPath = asString(details?.fieldPath);
    const issueCode = asString(details?.issueCode);
    const fallback = "Fix the invalid configuration field.";
    if (fieldPath === undefined && issueCode === undefined) {
        return fallback;
    }
    const where = [
        ...(fieldPath === undefined ? [] : [`field '${fieldPath}'`]),
        ...(issueCode === undefined ? [] : [`(${issueCode})`])
    ].join(" ");
    return `Fix invalid configuration ${where}.`;
}
