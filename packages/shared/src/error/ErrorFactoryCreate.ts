import { ControlError, type ControlErrorBody } from "./ErrorBodyControl.js";

export function createError(body: ControlErrorBody): ControlError {
    return new ControlError(body);
}
