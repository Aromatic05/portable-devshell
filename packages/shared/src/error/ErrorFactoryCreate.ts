import { ControlError, type ControlErrorInit } from "./ErrorBodyControl.js";

export function createError(body: ControlErrorInit): ControlError {
    return new ControlError(body);
}
