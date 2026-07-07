import { ControlError, type ControlErrorBody } from "./ControlError.js";

export function createError(body: ControlErrorBody): ControlError {
    return new ControlError(body);
}
