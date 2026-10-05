import type { WorkerProtocolRange, WorkerHandshakeParams, WorkerPingResult, WorkerStopResult, WorkerCommandSessionOutputInput, WorkerCommandSessionCompleteInput, WorkerHandshakeResult, WorkerToolsListResult, WorkerWorkspacePrepareResult, WorkerExtensionResourcePrepareInput, WorkerExtensionResourcePrepareResult, WorkerAlertsReadResult } from "../../Api.js";
import {
    Endpoint,
    Rpc,
    type ControlInstanceAlertsConfig,
    type JsonValue,
} from "@portable-devshell/shared";

export const WORKER_PROTOCOL_VERSION = "1.0.0";
export const WORKER_PROTOCOL_RANGE = Object.freeze({
    max: WORKER_PROTOCOL_VERSION,
    min: WORKER_PROTOCOL_VERSION,
});





























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
    ): Promise<WorkerAlertsReadResult> {
        return asObjectResult<WorkerAlertsReadResult>(
            await this.#request("core", "alerts.touch", {
                config,
                workspace,
            } as unknown as JsonValue),
        );
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
        const rpc = new Rpc(
            await this.#endpoint.connect(this.#workerHost, port, signal),
        );
        try {
            return ((await rpc.request(method, message, signal)) ??
                null) as JsonValue;
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
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(value);
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
