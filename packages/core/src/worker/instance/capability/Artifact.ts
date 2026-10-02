import type {
    WorkerArtifactDirectPushInput,
    WorkerArtifactDirectPushResult,
    WorkerArtifactDirectReceiveOpenInput,
    WorkerArtifactDirectReceiveOpenResult,
    WorkerArtifactPayloadOpenInput,
    WorkerArtifactPayloadOpenResult,
    WorkerArtifactReceiveBeginInput,
    WorkerArtifactReceiveBeginResult,
    WorkerArtifactReceiveFinishResult,
    WorkerProtocolClient,
} from "../../protocol/Client.js";
import { WorkerTransportServiceClient } from "../../transport/service/Client.js";
import type {
    WorkerArtifactPayloadReadInput,
    WorkerArtifactPayloadReadResult,
    WorkerArtifactReceiveWriteInput,
    WorkerArtifactReceiveWriteResult,
} from "../../transport/service/Model.js";
interface WorkerInstanceArtifactOptions {
    assertReady(): void;
    protocolClient: WorkerProtocolClient;
    serviceClient: WorkerTransportServiceClient;
}

export class WorkerInstanceArtifact {
    readonly #assertReady: WorkerInstanceArtifactOptions["assertReady"];
    readonly #protocolClient: WorkerProtocolClient;
    readonly #serviceClient: WorkerTransportServiceClient;

    constructor(options: WorkerInstanceArtifactOptions) {
        this.#assertReady = options.assertReady;
        this.#protocolClient = options.protocolClient;
        this.#serviceClient = options.serviceClient;
    }

    async openPayload(
        input: WorkerArtifactPayloadOpenInput,
        signal?: AbortSignal,
    ): Promise<WorkerArtifactPayloadOpenResult> {
        this.#assertReady();
        return await this.#protocolClient.openArtifactPayload(input, signal);
    }

    async readPayload(
        input: WorkerArtifactPayloadReadInput,
        signal?: AbortSignal,
    ): Promise<WorkerArtifactPayloadReadResult> {
        this.#assertReady();
        return await this.#serviceClient.readArtifactPayload(input, signal);
    }

    async closePayload(payloadId: string): Promise<void> {
        this.#assertReady();
        await this.#protocolClient.closeArtifactPayload(payloadId);
    }

    async beginReceive(
        input: WorkerArtifactReceiveBeginInput,
        signal?: AbortSignal,
    ): Promise<WorkerArtifactReceiveBeginResult> {
        this.#assertReady();
        return await this.#protocolClient.beginArtifactReceive(input, signal);
    }

    async writeReceive(
        input: WorkerArtifactReceiveWriteInput,
        signal?: AbortSignal,
    ): Promise<WorkerArtifactReceiveWriteResult> {
        this.#assertReady();
        return await this.#serviceClient.writeArtifactReceive(input, signal);
    }

    async finishReceive(
        receiveId: string,
    ): Promise<WorkerArtifactReceiveFinishResult> {
        this.#assertReady();
        return await this.#protocolClient.finishArtifactReceive(receiveId);
    }

    async abortReceive(receiveId: string): Promise<void> {
        this.#assertReady();
        await this.#protocolClient.abortArtifactReceive(receiveId);
    }

    async openDirectReceive(
        input: WorkerArtifactDirectReceiveOpenInput,
        signal?: AbortSignal,
    ): Promise<WorkerArtifactDirectReceiveOpenResult> {
        this.#assertReady();
        return await this.#protocolClient.openArtifactDirectReceive(
            input,
            signal,
        );
    }

    async closeDirectReceive(receiverId: string): Promise<void> {
        this.#assertReady();
        await this.#protocolClient.closeArtifactDirectReceive(receiverId);
    }

    async pushPayloadDirect(
        input: WorkerArtifactDirectPushInput,
    ): Promise<WorkerArtifactDirectPushResult> {
        this.#assertReady();
        return await this.#protocolClient.pushArtifactPayloadDirect(input);
    }
}
