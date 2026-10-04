import type {
    JsonValue,
    ToolCallPresentation,
} from "@portable-devshell/shared";

export class PresentedToolCallResult {
    readonly presentation: ToolCallPresentation;
    readonly result: JsonValue;

    constructor(result: JsonValue, presentation: ToolCallPresentation) {
        this.result = result;
        this.presentation = presentation;
    }
}

export function presentToolCallResult(
    result: JsonValue,
    presentation: ToolCallPresentation,
): PresentedToolCallResult {
    return new PresentedToolCallResult(result, presentation);
}
