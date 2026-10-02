// Context control contract. Context records are read and mutated over the
// control `context` port; no instance event stream is involved.

import type { McpContextRecord } from "./Model.js";

export const contextOperations = {
    disable: "disable",
    list: "list",
    renew: "renew",
} as const;

export interface ContextContract {
    disable: {
        request: { ctxId: string };
        response: McpContextRecord;
    };
    list: {
        request: undefined;
        response: McpContextRecord[];
    };
    renew: {
        request: { ctxId: string };
        response: McpContextRecord;
    };
}

export type ContextOperation = keyof ContextContract;

export type ContextRequestPayload<Operation extends ContextOperation> =
    ContextContract[Operation]["request"];

export type ContextResponse<Operation extends ContextOperation> =
    ContextContract[Operation]["response"];