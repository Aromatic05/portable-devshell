import type {
    WorkerArtifactDirectPushInput,
    WorkerArtifactDirectPushResult,
    WorkerArtifactDirectReceiveOpenInput,
    WorkerArtifactDirectReceiveOpenResult,
    WorkerArtifactPayloadOpenInput,
    WorkerArtifactPayloadOpenResult,
    WorkerArtifactPayloadReadInput,
    WorkerArtifactPayloadReadResult,
    WorkerArtifactReceiveBeginInput,
    WorkerArtifactReceiveBeginResult,
    WorkerArtifactReceiveFinishResult,
    WorkerArtifactReceiveWriteInput,
    WorkerArtifactReceiveWriteResult,
    WorkerProtocolClient
} from "../protocol/WorkerProtocolClient.js";

interface WorkerInstanceArtifactOptions {
    assertReady(): void;
    protocolClient: WorkerProtocolClient;
}

export class WorkerInstanceArtifact {
    readonly #assertReady: WorkerInstanceArtifactOptions["assertReady"];
    readonly #protocolClient: WorkerProtocolClient;

    constructor(options: WorkerInstanceArtifactOptions) {
        this.#assertReady = options.assertReady;
        this.#protocolClient = options.protocolClient;
    }

    async openPayload(input: WorkerArtifactPayloadOpenInput): Promise<WorkerArtifactPayloadOpenResult> {
        this.#assertReady();
        return await this.#protocolClient.openArtifactPayload(input);
    }

    async readPayload(input: WorkerArtifactPayloadReadInput): Promise<WorkerArtifactPayloadReadResult> {
        this.#assertReady();
        return await this.#protocolClient.readArtifactPayload(input);
    }

    async closePayload(payloadId: string): Promise<void> {
        this.#assertReady();
        await this.#protocolClient.closeArtifactPayload(payloadId);
    }

    async beginReceive(input: WorkerArtifactReceiveBeginInput): Promise<WorkerArtifactReceiveBeginResult> {
        this.#assertReady();
        return await this.#protocolClient.beginArtifactReceive(input);
    }

    async writeReceive(input: WorkerArtifactReceiveWriteInput): Promise<WorkerArtifactReceiveWriteResult> {
        this.#assertReady();
        return await this.#protocolClient.writeArtifactReceive(input);
    }

    async finishReceive(receiveId: string): Promise<WorkerArtifactReceiveFinishResult> {
        this.#assertReady();
        return await this.#protocolClient.finishArtifactReceive(receiveId);
    }

    async abortReceive(receiveId: string): Promise<void> {
        this.#assertReady();
        await this.#protocolClient.abortArtifactReceive(receiveId);
    }

    async openDirectReceive(
        input: WorkerArtifactDirectReceiveOpenInput
    ): Promise<WorkerArtifactDirectReceiveOpenResult> {
        this.#assertReady();
        return await this.#protocolClient.openArtifactDirectReceive(input);
    }

    async closeDirectReceive(receiverId: string): Promise<void> {
        this.#assertReady();
        await this.#protocolClient.closeArtifactDirectReceive(receiverId);
    }

    async pushPayloadDirect(input: WorkerArtifactDirectPushInput): Promise<WorkerArtifactDirectPushResult> {
        this.#assertReady();
        return await this.#protocolClient.pushArtifactPayloadDirect(input);
    }
}
