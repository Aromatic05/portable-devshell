// Instance-management wire contract. These are Control-plane operations that
// create and enable/disable instances; runtime lifecycle is a separate domain.

import type { InstanceListEntry } from "../../../runtime/state/Model.js";
import type { JsonValue } from "../../../transport/primitive/JsonValue.js";
import type {
    InstanceCreateDraft,
    InstanceCreateResult,
    InstanceCreateSchema,
    InstanceCreateSummary,
} from "./Model.js";

export const instanceOperations = {
    create: "create",
    createSchema: "createSchema",
    delete: "delete",
    disable: "disable",
    enable: "enable",
    list: "list",
    validateCreate: "validateCreate",
} as const;

export interface InstanceContract {
    create: {
        request: InstanceCreateDraft;
        response: InstanceCreateResult;
    };
    createSchema: {
        request: undefined;
        response: InstanceCreateSchema;
    };
    delete: {
        request: { instanceName: string };
        response: Record<string, JsonValue>;
    };
    disable: {
        request: { instanceName: string };
        response: Record<string, JsonValue>;
    };
    enable: {
        request: { instanceName: string };
        response: Record<string, JsonValue>;
    };
    list: {
        request: undefined;
        response: InstanceListEntry[];
    };
    validateCreate: {
        request: InstanceCreateDraft;
        response: InstanceCreateSummary;
    };
}

export type InstanceOperation = keyof InstanceContract;

export type InstanceRequest<Operation extends InstanceOperation> =
    InstanceContract[Operation]["request"];

export type InstanceResponse<Operation extends InstanceOperation> =
    InstanceContract[Operation]["response"];
