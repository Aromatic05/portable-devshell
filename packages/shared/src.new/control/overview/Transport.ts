import type { Endpoint } from "../../transport/endpoint/Endpoint.js";
import {
    createPortClient,
    type PortClient,
} from "../../transport/endpoint/PortClient.js";
import { CONTROL_HOST } from "../connection/Control.js";
import {
    overviewOperations,
    type OverviewOperation,
    type OverviewRequest,
    type OverviewResponse,
} from "./Contract.js";
import type { OperationalOverview } from "./Model.js";

export interface OverviewTransport {
    get(): Promise<OperationalOverview>;
}

export function createOverviewTransport(endpoint: Endpoint): OverviewTransport {
    return overviewTransport(createPortClient(endpoint, CONTROL_HOST, "overview"));
}

export function overviewTransport(port: PortClient): OverviewTransport {
    const request = <Operation extends OverviewOperation>(
        operation: Operation,
        payload: OverviewRequest<Operation>,
    ): Promise<OverviewResponse<Operation>> =>
        port.request<OverviewResponse<Operation>>(operation, payload);
    return {
        get: () => request(overviewOperations.get, undefined),
    };
}