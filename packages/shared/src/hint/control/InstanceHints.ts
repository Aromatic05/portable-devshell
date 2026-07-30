import type { ControlErrorBody } from "../../error/ErrorBodyControl.js";
import { asRecord, asString } from "../JsonRead.js";
import { errorHint, type ToolDiagnosticHint } from "../ToolDiagnosticHint.js";

export function instanceErrorHints(body: ControlErrorBody): ToolDiagnosticHint[] {
    switch (body.code) {
        case "control.instanceAlreadyExists":
            return [errorHint(
                "control.instanceAlreadyExists",
                "An instance with that name already exists. Do not overwrite it or auto-generate a new name; inspect instance_list and choose another name or reuse the existing instance."
            )];
        case "control.instanceNotFound":
            return [errorHint(
                "control.instanceNotFound",
                "The named instance does not exist. Check instance_list for valid names; do not guess instance names."
            )];
        case "instance.conflict":
            return [errorHint(
                "instance.conflict",
                "The instance operation conflicts with its current state. Re-check instance_status and retry a consistent operation; do not force concurrent lifecycle changes."
            )];
        case "control.configInvalid":
            return [errorHint(
                "control.configInvalid",
                configInvalidDetail(body)
            )];
        case "control.configValidationFailed":
            return [errorHint(
                "control.configValidationFailed",
                "The instance configuration failed validation. Fix the reported fields; do not relax the validator, remove safety checks, or bypass the create coordinator by editing TOML directly."
            )];
        default:
            return [];
    }
}

function configInvalidDetail(body: ControlErrorBody): string {
    const details = asRecord(body.details);
    const fieldPath = asString(details?.fieldPath);
    const issueCode = asString(details?.issueCode);
    const fallback = "The instance configuration is invalid. Fix the offending field; do not relax the validator, remove safety checks, or bypass the create coordinator by editing TOML directly.";
    if (fieldPath === undefined && issueCode === undefined) {
        return fallback;
    }
    const where = [
        ...(fieldPath === undefined ? [] : [`field '${fieldPath}'`]),
        ...(issueCode === undefined ? [] : [`(${issueCode})`])
    ].join(" ");
    return `The instance configuration is invalid at ${where}. Fix that specific field; do not relax the validator, remove safety checks, or bypass the create coordinator by editing TOML directly.`;
}
