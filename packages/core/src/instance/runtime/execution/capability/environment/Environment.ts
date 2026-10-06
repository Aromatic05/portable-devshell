import type { ControlInstanceAlertsConfig } from "@portable-devshell/shared";

import type {
    WorkerAlertsReadResult,
    WorkerExtensionResourcePrepareInput,
    WorkerExtensionResourcePrepareResult,
    WorkerWorkspacePrepareResult,
} from "../../../../Api.js";
import type { WorkerEnvironment as WorkerEnvironmentApi } from "../../../Api.js";
import type { WorkerProtocolClient } from "../../../../transport/packet/Client.js";

export class WorkerEnvironment implements WorkerEnvironmentApi {
    readonly #alerts: ControlInstanceAlertsConfig | undefined;
    readonly #assertReady: () => void;
    readonly #protocolClient: WorkerProtocolClient;

    constructor(dependencies: {
        alerts: ControlInstanceAlertsConfig | undefined;
        assertReady: () => void;
        protocolClient: WorkerProtocolClient;
    }) {
        this.#alerts = dependencies.alerts;
        this.#assertReady = dependencies.assertReady;
        this.#protocolClient = dependencies.protocolClient;
    }

    async prepareExtensionResource(
        input: WorkerExtensionResourcePrepareInput,
    ): Promise<WorkerExtensionResourcePrepareResult> {
        this.#assertReady();
        return await this.#protocolClient.prepareExtensionResource(input);
    }

    async prepareWorkspace(
        workspace: string,
    ): Promise<WorkerWorkspacePrepareResult> {
        this.#assertReady();
        return await this.#protocolClient.prepareWorkspace(workspace);
    }

    async readAlerts(workspace: string): Promise<WorkerAlertsReadResult> {
        this.#assertReady();
        return await this.#protocolClient.readAlerts(workspace, this.#alerts);
    }

    async releaseAlerts(workspace: string): Promise<void> {
        this.#assertReady();
        await this.#protocolClient.releaseAlerts(workspace);
    }

    async touchAlerts(workspace: string): Promise<WorkerAlertsReadResult> {
        this.#assertReady();
        return await this.#protocolClient.touchAlerts(workspace, this.#alerts);
    }

    async touchTemporaryDirectory(path: string): Promise<void> {
        this.#assertReady();
        await this.#protocolClient.touchTemporaryDirectory(path);
    }
}
