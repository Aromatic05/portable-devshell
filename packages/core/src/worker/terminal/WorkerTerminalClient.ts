import type { JsonValue } from "@portable-devshell/shared";

import type { WorkerRpcBridge } from "../rpc/WorkerRpcBridge.js";
import type { WorkerRpcClient } from "../rpc/WorkerRpcClient.js";
import type { WorkerRpcError } from "../rpc/WorkerRpcError.js";

export interface WorkerTerminalDescriptor {
    cols: number;
    createdAtMs: number;
    generation: number;
    latestSeq: number;
    rows: number;
    state: "running" | "exited";
    terminalId: string;
    version: number;
}

export interface WorkerTerminalOpenInput {
    cols: number;
    command?: string;
    cwd?: string;
    rows: number;
    workspace: string;
}

export interface WorkerTerminalIdentity {
    clientSeq: number;
    generation: number;
    terminalId: string;
    version: number;
}

export interface WorkerTerminalOutputFrame {
    dataBase64: string;
    seq: number;
}

export interface WorkerTerminalAttachResult {
    exit?: { exitCode: number; signal: number };
    replay: WorkerTerminalOutputFrame[];
    session: WorkerTerminalDescriptor;
}

export type WorkerTerminalNotification =
    | {
          method: "terminal.output";
          params: {
              dataBase64: string;
              generation: number;
              seq: number;
              terminalId: string;
          };
      }
    | {
          method: "terminal.exit";
          params: {
              exitCode: number;
              generation: number;
              signal: number;
              terminalId: string;
              version: number;
          };
      };

export class WorkerTerminalClient {
    readonly #bridge: WorkerRpcBridge;
    readonly #rpcClient: WorkerRpcClient;

    constructor(rpcClient: WorkerRpcClient, bridge: WorkerRpcBridge) {
        this.#bridge = bridge;
        this.#rpcClient = rpcClient;
    }

    async open(input: WorkerTerminalOpenInput): Promise<WorkerTerminalDescriptor> {
        return asResult<WorkerTerminalDescriptor>(
            await this.#rpcClient.request("terminal.open", input as unknown as JsonValue)
        );
    }

    async attach(input: {
        fromSeq: number;
        generation: number;
        terminalId: string;
    }): Promise<WorkerTerminalAttachResult> {
        return asResult<WorkerTerminalAttachResult>(
            await this.#rpcClient.request("terminal.attach", input as unknown as JsonValue)
        );
    }

    async write(
        input: WorkerTerminalIdentity & { data: string }
    ): Promise<WorkerTerminalIdentity & { accepted: boolean }> {
        return asResult<WorkerTerminalIdentity & { accepted: boolean }>(
            await this.#rpcClient.request("terminal.write", input as unknown as JsonValue)
        );
    }

    async resize(
        input: WorkerTerminalIdentity & { cols: number; rows: number }
    ): Promise<WorkerTerminalIdentity & { accepted: boolean }> {
        return asResult<WorkerTerminalIdentity & { accepted: boolean }>(
            await this.#rpcClient.request("terminal.resize", input as unknown as JsonValue)
        );
    }

    async kill(input: WorkerTerminalIdentity): Promise<WorkerTerminalDescriptor> {
        return asResult<WorkerTerminalDescriptor>(
            await this.#rpcClient.request("terminal.kill", input as unknown as JsonValue)
        );
    }

    async list(): Promise<WorkerTerminalDescriptor[]> {
        return asResult<WorkerTerminalDescriptor[]>(
            await this.#rpcClient.request("terminal.list", {})
        );
    }

    onNotification(listener: (notification: WorkerTerminalNotification) => void): () => void {
        return this.#bridge.onNotification((notification) => {
            const parsed = parseNotification(notification.method, notification.params);
            if (parsed !== undefined) listener(parsed);
        });
    }

    onConnected(listener: () => void): () => void {
        return this.#bridge.onConnected(listener);
    }

    onDisconnected(listener: (error: WorkerRpcError) => void): () => void {
        return this.#bridge.onDisconnect(listener);
    }
}

function parseNotification(
    method: string,
    params: JsonValue
): WorkerTerminalNotification | undefined {
    if (method !== "terminal.output" && method !== "terminal.exit") return undefined;
    if (typeof params !== "object" || params === null || Array.isArray(params)) return undefined;
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
                  params: { dataBase64, generation, seq, terminalId }
              };
    }
    const version = readInteger(value.version);
    const exitCode = readInteger(value.exitCode);
    const signal = readInteger(value.signal);
    return version === undefined || exitCode === undefined || signal === undefined
        ? undefined
        : {
              method,
              params: { exitCode, generation, signal, terminalId, version }
          };
}

function readInteger(value: JsonValue | undefined): number | undefined {
    return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function readString(value: JsonValue | undefined): string | undefined {
    return typeof value === "string" ? value : undefined;
}

function asResult<T>(value: JsonValue): T {
    return value as T;
}
