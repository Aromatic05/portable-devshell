import type { WorkerTerminalDescriptor, WorkerTerminalOpenInput, WorkerTerminalIdentity, WorkerTerminalAttachResult, WorkerTerminalNotification } from "../../Api.js";
import {
    Endpoint,
    Event,
    createPortClient,
    type PortClient,
    type JsonValue,
} from "@portable-devshell/shared";













export class WorkerTerminal {
    readonly #endpoint: Endpoint;
    readonly #port: PortClient;
    readonly #events: Event;
    readonly #workerHost: string;

    constructor(endpoint: Endpoint, workerHost: string) {
        this.#endpoint = endpoint;
        this.#workerHost = workerHost;
        this.#port = createPortClient(endpoint, workerHost, "terminal");
        this.#events = new Event(endpoint.bind("terminal"));
    }

    async open(
        input: WorkerTerminalOpenInput,
    ): Promise<WorkerTerminalDescriptor> {
        return await this.#request("terminal.open", input);
    }

    async attach(input: {
        fromSeq: number;
        generation: number;
        terminalId: string;
    }): Promise<WorkerTerminalAttachResult> {
        return await this.#request("terminal.attach", input);
    }

    async write(
        input: WorkerTerminalIdentity & { data: string },
    ): Promise<WorkerTerminalIdentity & { accepted: boolean }> {
        return await this.#request("terminal.write", input);
    }

    async resize(
        input: WorkerTerminalIdentity & { cols: number; rows: number },
    ): Promise<WorkerTerminalIdentity & { accepted: boolean }> {
        return await this.#request("terminal.resize", input);
    }

    async kill(
        input: WorkerTerminalIdentity,
    ): Promise<WorkerTerminalDescriptor> {
        return await this.#request("terminal.kill", input);
    }

    async list(): Promise<WorkerTerminalDescriptor[]> {
        return await this.#request("terminal.list", {});
    }

    onNotification(
        listener: (notification: WorkerTerminalNotification) => void,
    ): () => void {
        return this.#events.onEvent((name, message, peer) => {
            if (peer.host !== this.#workerHost) return;
            const notification = parseNotification(
                `terminal.${name}`,
                (message ?? null) as JsonValue,
            );
            if (notification !== undefined) listener(notification);
        });
    }

    onConnected(listener: () => void): () => void {
        return this.#endpoint.onTransportOpen(listener);
    }

    onDisconnected(listener: (error: Error) => void): () => void {
        return this.#endpoint.onTransportClose((error) =>
            listener(error ?? new Error("Worker transport closed.")),
        );
    }

    async #request<T>(method: string, message: unknown): Promise<T> {
        return await this.#port.request<T>(method, message);
    }
}

function parseNotification(
    method: string,
    params: JsonValue,
): WorkerTerminalNotification | undefined {
    if (method !== "terminal.output" && method !== "terminal.exit")
        return undefined;
    if (typeof params !== "object" || params === null || Array.isArray(params))
        return undefined;
    const value = params as Record<string, JsonValue>;
    const terminalId = readString(value.terminalId);
    const generation = readInteger(value.generation);
    if (terminalId === undefined || generation === undefined) return undefined;
    if (method === "terminal.output") {
        const seq = readInteger(value.seq);
        const dataBase64 = readString(value.dataBase64);
        return seq === undefined || dataBase64 === undefined
            ? undefined
            : {
                  method,
                  params: { dataBase64, generation, seq, terminalId },
              };
    }
    const version = readInteger(value.version);
    const exitCode = readInteger(value.exitCode);
    const signal = readInteger(value.signal);
    return version === undefined ||
        exitCode === undefined ||
        signal === undefined
        ? undefined
        : {
              method,
              params: { exitCode, generation, signal, terminalId, version },
          };
}

function readInteger(value: JsonValue | undefined): number | undefined {
    return typeof value === "number" && Number.isSafeInteger(value)
        ? value
        : undefined;
}

function readString(value: JsonValue | undefined): string | undefined {
    return typeof value === "string" ? value : undefined;
}

function asResult<T>(value: JsonValue): T {
    return value as T;
}
