import type { Endpoint } from "../../transport/endpoint/Endpoint.js";
import { createPortClient } from "../../transport/endpoint/PortClient.js";
import { asInstanceName } from "../../types/Instance.js";
import type {
    WorkerAlertsReadResult,
    WorkerExtensionResourcePrepareInput,
    WorkerExtensionResourcePrepareResult,
    WorkerWorkspacePrepareResult,
} from "./Model.js";

export const ENVIRONMENT_PORT = "environment";

export interface EnvironmentTransport {
    prepareExtensionResource(
        input: WorkerExtensionResourcePrepareInput,
    ): Promise<WorkerExtensionResourcePrepareResult>;
    prepareWorkspace(workspace: string): Promise<WorkerWorkspacePrepareResult>;
    readAlerts(workspace: string): Promise<WorkerAlertsReadResult>;
    releaseAlerts(workspace: string): Promise<void>;
    touchAlerts(workspace: string): Promise<WorkerAlertsReadResult>;
    touchTemporaryDirectory(path: string): Promise<void>;
}

export function createEnvironmentTransport(
    endpoint: Endpoint,
    instance: string,
): EnvironmentTransport {
    const port = createPortClient(endpoint, asInstanceName(instance), ENVIRONMENT_PORT);
    return {
        prepareExtensionResource: (input) =>
            port.request<WorkerExtensionResourcePrepareResult>(
                "prepareExtensionResource",
                input,
            ),
        prepareWorkspace: (workspace) =>
            port.request<WorkerWorkspacePrepareResult>("prepareWorkspace", {
                workspace,
            }),
        readAlerts: (workspace) =>
            port.request<WorkerAlertsReadResult>("readAlerts", { workspace }),
        releaseAlerts: async (workspace) => {
            await port.request("releaseAlerts", { workspace });
        },
        touchAlerts: (workspace) =>
            port.request<WorkerAlertsReadResult>("touchAlerts", { workspace }),
        touchTemporaryDirectory: async (path) => {
            await port.request("touchTemporaryDirectory", { path });
        },
    };
}
