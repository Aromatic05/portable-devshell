import {
    Endpoint,
    Rpc,
    type ArtifactPayloadDescriptor,
    type ControlInstanceAlertsConfig,
    type JsonValue,
} from "@portable-devshell/shared";

export const WORKER_PROTOCOL_VERSION = "1.0.0";
export const WORKER_PROTOCOL_RANGE = Object.freeze({
    max: WORKER_PROTOCOL_VERSION,
    min: WORKER_PROTOCOL_VERSION,
});
export interface WorkerProtocolRange {
    min: string;
    max: string;
}

export interface WorkerHandshakeParams {
    protocolRange: WorkerProtocolRange;
    clientName: string;
    clientVersion: string;
}

export interface WorkerPingResult {
    pong: boolean;
}
export interface WorkerStopResult {
    stopping: boolean;
}

export interface WorkerCommandSessionOutputInput {
    data: string;
    sessionId: string;
    stream: "stderr" | "stdout";
}

export interface WorkerCommandSessionCompleteInput {
    error?: string;
    exitCode: number;
    sessionId: string;
}

export interface WorkerShellRuntime {
    executable: string;
    kind: "bash" | "powershell" | string;
    version: string;
}

export interface WorkerHandshakeResult {
    homeDirectory: string;
    instance: string;
    workerVersion: string;
    workerSha256?: string;
    protocolVersion: string;
    platform: {
        os: string;
        arch: string;
        distribution?: { id: string; name: string; version?: string };
        packageManager?: string;
        shell?: WorkerShellRuntime;
    };
    capabilities: {
        tools: boolean;
        streaming: boolean;
        cancel: boolean;
    };
}

export interface WorkerToolDefinition {
    requiredCapabilities: readonly ("read" | "write" | "execute")[];
    name: string;
    description: string;
    group: string;
    inputSchema: JsonValue;
    outputSchema: JsonValue;
}

export interface WorkerToolsListResult {
    tools: WorkerToolDefinition[];
}

export interface WorkerWorkspacePrepareResult {
    projectMemoryAgentFile: string;
    projectMemoryDirectory: string;
    projectMemoryPresent?: boolean;
    temporaryDirectory: string;
    workspace: string;
}

export interface WorkerExtensionResourcePrepareInput {
    collection: string;
    extensionId: string;
}

export interface WorkerExtensionResourcePrepareResult {
    directory: string;
}

export interface WorkerAlertAdvice {
    code: string;
    text: string;
}

export interface WorkerAlertsReadResult {
    advice: WorkerAlertAdvice[];
}

export type WorkerArtifactPayloadOpenInput =
    | { expiresAtMs: number; handle: string; path?: never }
    | { expiresAtMs: number; handle?: never; path: string; workspace: string };

export interface WorkerArtifactPayloadOpenResult {
    descriptor: ArtifactPayloadDescriptor;
    expiresAtMs: number;
    payloadId: string;
}

export interface WorkerArtifactPayloadReadInput {
    maxBytes: number;
    offsetBytes: number;
    payloadId: string;
}

export interface WorkerArtifactPayloadReadResult {
    content: string;
    encoding: "base64";
    eof: boolean;
    nextOffsetBytes?: number;
    offsetBytes: number;
    payloadId: string;
    returnedBytes: number;
    totalBytes: number;
}

export interface WorkerArtifactReceiveBeginInput {
    descriptor: ArtifactPayloadDescriptor;
    overwrite: boolean;
    targetPath: string;
    workspace: string;
}

export interface WorkerArtifactReceiveBeginResult {
    nextOffsetBytes: number;
    receiveId: string;
}

export interface WorkerArtifactReceiveWriteInput {
    content: string;
    offsetBytes: number;
    receiveId: string;
}

export interface WorkerArtifactReceiveWriteResult {
    nextOffsetBytes: number;
    receivedBytes: number;
    receiveId: string;
}

export interface WorkerArtifactReceiveFinishResult {
    blake3: string;
    bytes: number;
    receiveId: string;
    targetPath: string;
}

export interface WorkerArtifactDirectReceiveOpenInput {
    expiresAtMs: number;
    receiveId: string;
}

export interface WorkerArtifactDirectReceiveOpenResult {
    expiresAtMs: number;
    nextOffsetBytes: number;
    receiverId: string;
    urls: string[];
}

export interface WorkerArtifactDirectPushInput {
    maxBytes: number;
    offsetBytes: number;
    payloadId: string;
    urls: string[];
}

export interface WorkerArtifactDirectPushResult {
    nextOffsetBytes: number;
    pushedBytes: number;
}

export class WorkerProtocolClient {
    readonly #endpoint: Endpoint;
    readonly #workerHost: string;

    constructor(endpoint: Endpoint, workerHost: string) {
        this.#endpoint = endpoint;
        this.#workerHost = workerHost;
    }

    async ping(): Promise<WorkerPingResult> {
        return asObjectResult<WorkerPingResult>(
            await this.#request("core", "worker.ping", {}),
        );
    }

    async handshake(
        params: WorkerHandshakeParams,
    ): Promise<WorkerHandshakeResult> {
        const result = asObjectResult<
            Omit<WorkerHandshakeResult, "protocolVersion"> & {
                protocolVersion: string | number;
            }
        >(
            await this.#request(
                "core",
                "worker.handshake",
                params as unknown as JsonValue,
            ),
        );
        if (typeof result.protocolVersion !== "string") {
            throw new TypeError(
                `Unsupported Worker protocol version ${String(result.protocolVersion)}.`,
            );
        }
        assertNegotiatedWorkerProtocolVersion(
            result.protocolVersion,
            params.protocolRange,
        );
        return {
            ...result,
            protocolVersion: result.protocolVersion,
        };
    }

    async listTools(): Promise<WorkerToolsListResult> {
        return asObjectResult<WorkerToolsListResult>(
            await this.#request("tool", "tools.list", {}),
        );
    }

    async prepareWorkspace(
        workspace: string,
    ): Promise<WorkerWorkspacePrepareResult> {
        return asObjectResult<WorkerWorkspacePrepareResult>(
            await this.#request("core", "workspace.prepare", { workspace }),
        );
    }

    async touchTemporaryDirectory(temporaryDirectory: string): Promise<void> {
        await this.#request("core", "workspace.touchTemporary", {
            temporaryDirectory,
        });
    }

    async readAlerts(
        workspace: string,
        config: ControlInstanceAlertsConfig | undefined,
    ): Promise<WorkerAlertsReadResult> {
        return asObjectResult<WorkerAlertsReadResult>(
            await this.#request("core", "alerts.read", {
                config,
                workspace,
            } as unknown as JsonValue),
        );
    }

    async configureAlerts(
        config: ControlInstanceAlertsConfig | undefined,
    ): Promise<void> {
        await this.#request("core", "alerts.configure", {
            config,
        } as unknown as JsonValue);
    }

    async touchAlerts(
        workspace: string,
        config: ControlInstanceAlertsConfig | undefined,
    ): Promise<void> {
        await this.#request("core", "alerts.touch", {
            config,
            workspace,
        } as unknown as JsonValue);
    }

    async releaseAlerts(workspace: string): Promise<void> {
        await this.#request("core", "alerts.release", { workspace });
    }

    async closeToolSession(sessionId: string): Promise<void> {
        await this.#request("tool", "tool.session.close", { sessionId });
    }

    async writeCommandSessionOutput(
        input: WorkerCommandSessionOutputInput,
    ): Promise<void> {
        await this.#request(
            "core",
            "devshell.command.output",
            input as unknown as JsonValue,
        );
    }

    async completeCommandSession(
        input: WorkerCommandSessionCompleteInput,
    ): Promise<void> {
        await this.#request(
            "core",
            "devshell.command.complete",
            input as unknown as JsonValue,
        );
    }

    async prepareExtensionResource(
        input: WorkerExtensionResourcePrepareInput,
    ): Promise<WorkerExtensionResourcePrepareResult> {
        return asObjectResult<WorkerExtensionResourcePrepareResult>(
            await this.#request(
                "core",
                "extension.resource.prepare",
                input as unknown as JsonValue,
            ),
        );
    }

    async openArtifactPayload(
        input: WorkerArtifactPayloadOpenInput,
        signal?: AbortSignal,
    ): Promise<WorkerArtifactPayloadOpenResult> {
        return asObjectResult<WorkerArtifactPayloadOpenResult>(
            await this.#request(
                "artifact",
                "artifact.payload.open",
                input as unknown as JsonValue,
                signal,
            ),
        );
    }

    async closeArtifactPayload(payloadId: string): Promise<void> {
        await this.#request("artifact", "artifact.payload.close", { payloadId });
    }

    async readArtifactPayload(
        input: WorkerArtifactPayloadReadInput,
        signal?: AbortSignal,
    ): Promise<WorkerArtifactPayloadReadResult> {
        return asObjectResult<WorkerArtifactPayloadReadResult>(
            await this.#request(
                "artifact",
                "artifact.payload.read",
                input as unknown as JsonValue,
                signal,
            ),
        );
    }

    async beginArtifactReceive(
        input: WorkerArtifactReceiveBeginInput,
        signal?: AbortSignal,
    ): Promise<WorkerArtifactReceiveBeginResult> {
        return asObjectResult<WorkerArtifactReceiveBeginResult>(
            await this.#request(
                "artifact",
                "artifact.receive.begin",
                input as unknown as JsonValue,
                signal,
            ),
        );
    }

    async finishArtifactReceive(
        receiveId: string,
    ): Promise<WorkerArtifactReceiveFinishResult> {
        return asObjectResult<WorkerArtifactReceiveFinishResult>(
            await this.#request("artifact", "artifact.receive.finish", {
                receiveId,
            }),
        );
    }

    async abortArtifactReceive(receiveId: string): Promise<void> {
        await this.#request("artifact", "artifact.receive.abort", { receiveId });
    }

    async writeArtifactReceive(
        input: WorkerArtifactReceiveWriteInput,
        signal?: AbortSignal,
    ): Promise<WorkerArtifactReceiveWriteResult> {
        return asObjectResult<WorkerArtifactReceiveWriteResult>(
            await this.#request(
                "artifact",
                "artifact.receive.write",
                input as unknown as JsonValue,
                signal,
            ),
        );
    }

    async openArtifactDirectReceive(
        input: WorkerArtifactDirectReceiveOpenInput,
        signal?: AbortSignal,
    ): Promise<WorkerArtifactDirectReceiveOpenResult> {
        return asObjectResult<WorkerArtifactDirectReceiveOpenResult>(
            await this.#request(
                "artifact",
                "artifact.receive.direct.open",
                input as unknown as JsonValue,
                signal,
            ),
        );
    }

    async closeArtifactDirectReceive(receiverId: string): Promise<void> {
        await this.#request("artifact", "artifact.receive.direct.close", {
            receiverId,
        });
    }

    async pushArtifactPayloadDirect(
        input: WorkerArtifactDirectPushInput,
    ): Promise<WorkerArtifactDirectPushResult> {
        return asObjectResult<WorkerArtifactDirectPushResult>(
            await this.#request(
                "artifact",
                "artifact.payload.direct.push",
                input as unknown as JsonValue,
            ),
        );
    }

    async stop(): Promise<WorkerStopResult> {
        return asObjectResult<WorkerStopResult>(
            await this.#request("core", "worker.stop", {}),
        );
    }

    async #request(
        port: string,
        method: string,
        message?: JsonValue,
        signal?: AbortSignal,
    ): Promise<JsonValue> {
        const rpc = new Rpc(await this.#endpoint.connect(this.#workerHost, port, signal));
        try {
            return ((await rpc.request(method, message, signal)) ?? null) as JsonValue;
        } finally {
            rpc.close();
        }
    }
}

function asObjectResult<T>(value: JsonValue): T {
    return value as T;
}

interface WorkerProtocolSemVer {
    major: number;
    minor: number;
    patch: number;
}

function assertNegotiatedWorkerProtocolVersion(
    version: string,
    range: WorkerProtocolRange,
): void {
    const selected = parseWorkerProtocolSemVer(version);
    const minimum = parseWorkerProtocolSemVer(range.min);
    const maximum = parseWorkerProtocolSemVer(range.max);
    if (compareWorkerProtocolSemVer(minimum, maximum) > 0) {
        throw new TypeError(
            `Invalid Worker protocol range ${range.min}..${range.max}.`,
        );
    }
    if (
        compareWorkerProtocolSemVer(selected, minimum) < 0 ||
        compareWorkerProtocolSemVer(selected, maximum) > 0
    ) {
        throw new TypeError(
            `Worker protocol version ${version} is outside requested range ${range.min}..${range.max}.`,
        );
    }
}

function parseWorkerProtocolSemVer(value: string): WorkerProtocolSemVer {
    const match =
        /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(value);
    if (match === null)
        throw new TypeError(`Invalid Worker protocol version ${value}.`);
    const major = Number(match[1]);
    const minor = Number(match[2]);
    const patch = Number(match[3]);
    if (![major, minor, patch].every(Number.isSafeInteger))
        throw new TypeError(`Invalid Worker protocol version ${value}.`);
    return { major, minor, patch };
}

function compareWorkerProtocolSemVer(
    left: WorkerProtocolSemVer,
    right: WorkerProtocolSemVer,
): number {
    if (left.major !== right.major) return left.major < right.major ? -1 : 1;
    if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1;
    if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1;
    return 0;
}
