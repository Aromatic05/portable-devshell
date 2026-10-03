import { CONTROL_HOST } from "../../client/Control.js";
import type { Endpoint } from "../../transport/endpoint/Endpoint.js";
import { createPortClient } from "../../transport/endpoint/PortClient.js";
import type { OperationalOverview } from "./Model.js";

export interface OverviewTransport {
    get(): Promise<OperationalOverview>;
}

export function createOverviewTransport(endpoint: Endpoint): OverviewTransport {
    const port = createPortClient(endpoint, CONTROL_HOST, "overview");
    return {
        get: () => port.request<OperationalOverview>("get"),
    };
}
