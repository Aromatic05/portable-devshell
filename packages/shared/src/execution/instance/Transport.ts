import type { Endpoint } from "../../transport/endpoint/Endpoint.js";
import { createPortClient } from "../../transport/endpoint/PortClient.js";
import { asInstanceName } from "../../types/Instance.js";
import type { JsonValue } from "../../types/Json.js";

export const INSTANCE_RUNTIME_PORT = "instance";

export interface InstanceRuntimeTransport {
    acquireReference(reference: string): Promise<Record<string, JsonValue>>;
    releaseReference(reference: string): Promise<void>;
}

export function createInstanceRuntimeTransport(
    endpoint: Endpoint,
    instance: string,
): InstanceRuntimeTransport {
    const port = createPortClient(
        endpoint,
        asInstanceName(instance),
        INSTANCE_RUNTIME_PORT,
    );
    return {
        acquireReference: (reference) =>
            port.request<Record<string, JsonValue>>("acquireReference", {
                reference,
            }),
        releaseReference: async (reference) => {
            await port.request("releaseReference", { reference });
        },
    };
}
