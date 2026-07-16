import type { Socket } from "node:net";

import {
    ClientConnection,
    type ControlErrorBody
} from "@portable-devshell/shared";

import { createTuiClientArtifact, type TuiClientArtifact } from "./artifact/TuiClientArtifact.js";
import { createTuiClientConfig, type TuiClientConfig } from "./config/TuiClientConfig.js";
import { createTuiClientInstance, type TuiClientInstance } from "./instance/TuiClientInstance.js";
import { createTuiClientMcp, type TuiClientMcp } from "./mcp/TuiClientMcp.js";
import { createTuiClientReverse, type TuiClientReverse } from "../client/reverse/TuiClientReverse.js";
import { createTuiClientRuntime, type TuiClientRuntime } from "./runtime/TuiClientRuntime.js";
import { createTuiClientService, type TuiClientService } from "./service/TuiClientService.js";
import { createTuiClientTodo, type TuiClientTodo } from "./todo/TuiClientTodo.js";
import { createTuiClientTool, type TuiClientTool } from "./tool/TuiClientTool.js";

export interface TuiClientOptions {
    socketFactory?: (path: string) => Socket;
    socketPath?: string;
    xdgRuntimeDir?: string;
}

export interface TuiClients {
    artifact: TuiClientArtifact;
    close(): void;
    config: TuiClientConfig;
    instance: TuiClientInstance;
    mcp: TuiClientMcp;
    reconnect(): Promise<void>;
    reverse: TuiClientReverse;
    runtime: TuiClientRuntime;
    service: TuiClientService;
    todo: TuiClientTodo;
    tool: TuiClientTool;
}

export function createTuiClients(options: TuiClientOptions = {}): TuiClients {
    const connection = new ClientConnection({
        ...options,
        mode: "persistent",
        peer: "tui",
        mapError: toClientError,
        mapRemoteError: toRemoteError
    });
    return {
        artifact: createTuiClientArtifact(connection),
        close: () => connection.close(),
        config: createTuiClientConfig(connection),
        instance: createTuiClientInstance(connection),
        mcp: createTuiClientMcp(connection),
        reconnect: async () => await connection.reconnect(),
        reverse: createTuiClientReverse(connection),
        runtime: createTuiClientRuntime(connection),
        service: createTuiClientService(connection),
        todo: createTuiClientTodo(connection),
        tool: createTuiClientTool(connection)
    };
}

function toRemoteError(error: ControlErrorBody): Error {
    return Object.assign(new Error(error.message), {
        code: error.code,
        details: error.details,
        retryable: error.retryable
    });
}

function toClientError(error: unknown): Error {
    if (typeof error === "object" && error !== null && "code" in error) {
        const code = String(error.code);
        if (code === "ENOENT" || code === "ECONNREFUSED") {
            return Object.assign(new Error("control server is not running."), { code: "control.notRunning" });
        }
    }
    return error instanceof Error ? error : new Error(String(error));
}
