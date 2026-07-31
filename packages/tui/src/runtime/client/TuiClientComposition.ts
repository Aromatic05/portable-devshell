import type { Socket } from "node:net";

import {
    ClientConnection,
    SocketChannelProvider,
    type ControlErrorBody
} from "@portable-devshell/shared";

import { createTuiClientArtifact, type TuiClientArtifact } from "./artifact/TuiClientArtifact.js";
import { createTuiClientConfig, type TuiClientConfig } from "./config/TuiClientConfig.js";
import { createTuiClientContextMessage, type TuiClientContextMessage } from "./context/TuiClientContextMessage.js";
import { createTuiClientInstance, type TuiClientInstance } from "./instance/TuiClientInstance.js";
import { createTuiClientMcp, type TuiClientMcp } from "./mcp/TuiClientMcp.js";
import { createTuiClientOverview, type TuiClientOverview } from "./overview/TuiClientOverview.js";
import { createTuiClientReverse, type TuiClientReverse } from "./reverse/TuiClientReverse.js";
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
    contextMessage?: TuiClientContextMessage;
    instance: TuiClientInstance;
    mcp: TuiClientMcp;
    overview: TuiClientOverview;
    reconnect(): Promise<void>;
    reverse: TuiClientReverse;
    runtime: TuiClientRuntime;
    service: TuiClientService;
    todo: TuiClientTodo;
    tool: TuiClientTool;
}

export function createTuiClients(options: TuiClientOptions = {}): TuiClients {
    const connection = new ClientConnection({
        channelProvider: new SocketChannelProvider(options),
        mode: "persistent",
        peer: "tui",
        mapError: toClientError,
        mapRemoteError: toRemoteError
    });
    return {
        artifact: createTuiClientArtifact(connection),
        close: () => connection.close(),
        config: createTuiClientConfig(connection),
        contextMessage: createTuiClientContextMessage(connection),
        instance: createTuiClientInstance(connection),
        mcp: createTuiClientMcp(connection),
        overview: createTuiClientOverview(connection),
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
