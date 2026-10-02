// Thin typed instance-management transport on the Control instance port.

import type { Endpoint } from "../../../transport/endpoint/Endpoint.js";
import { Rpc } from "../../../transport/packet/Rpc.js";
import {
    instanceOperations,
    type InstanceOperation,
    type InstanceRequest,
    type InstanceResponse,
} from "./Contract.js";
import type {
    InstanceCreateDraft,
    InstanceCreateResult,
    InstanceCreateSchema,
    InstanceCreateSummary,
} from "./Model.js";
import type { InstanceListEntry } from "../../../runtime/state/Model.js";
import type { JsonValue } from "../../../transport/primitive/JsonValue.js";

export const INSTANCE_HOST = "@control";
export const INSTANCE_PORT = "instance";

export interface InstanceManagementTransport {
    create(draft: InstanceCreateDraft): Promise<InstanceCreateResult>;
    createSchema(): Promise<InstanceCreateSchema>;
    delete(instanceName: string): Promise<Record<string, JsonValue>>;
    disable(instanceName: string): Promise<Record<string, JsonValue>>;
    enable(instanceName: string): Promise<Record<string, JsonValue>>;
    list(): Promise<InstanceListEntry[]>;
    validateCreate(draft: InstanceCreateDraft): Promise<InstanceCreateSummary>;
}

export function createInstanceManagementTransport(
    endpoint: Endpoint,
): InstanceManagementTransport {
    const request = async <Operation extends InstanceOperation>(
        operation: Operation,
        payload: InstanceRequest<Operation>,
    ): Promise<InstanceResponse<Operation>> => {
        const rpc = new Rpc(await endpoint.connect(INSTANCE_HOST, INSTANCE_PORT));
        try {
            return await rpc.request<InstanceResponse<Operation>>(
                operation,
                payload,
            );
        } finally {
            rpc.close();
        }
    };
    return {
        create: (draft) => request(instanceOperations.create, draft),
        createSchema: () =>
            request(instanceOperations.createSchema, undefined),
        delete: (instanceName) =>
            request(instanceOperations.delete, { instanceName }),
        disable: (instanceName) =>
            request(instanceOperations.disable, { instanceName }),
        enable: (instanceName) =>
            request(instanceOperations.enable, { instanceName }),
        list: () => request(instanceOperations.list, undefined),
        validateCreate: (draft) =>
            request(instanceOperations.validateCreate, draft),
    };
}
