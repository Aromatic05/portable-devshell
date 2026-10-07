import { createToolCallRegistry } from "./toolcall/index.js";

export class ControlState {
    readonly toolCalls = createToolCallRegistry();
}
