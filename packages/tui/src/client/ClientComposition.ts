import type { Socket } from "node:net";

import {
    ClientConnection,
    type ControlErrorBody
} from "@portable-devshell/shared";

import { createArtifactClient, type ArtifactClient } from "../modules/artifact/ArtifactClient.js";
import { createConfigClient, type ConfigClient } from "../modules/config/ConfigClient.js";
import { createInstanceClient, type InstanceClient } from "../modules/instance/InstanceClient.js";
import { createMcpClient, type McpClient } from "../modules/mcp/McpClient.js";
import { createReverseClient, type ReverseClient } from "../modules/reverse/ReverseClient.js";
import { createRuntimeClient, type RuntimeClient } from "../modules/runtime/RuntimeClient.js";
import { createServiceClient, type ServiceClient } from "../modules/service/ServiceClient.js";
import { createTodoClient, type TodoClient } from "../modules/todo/TodoClient.js";
import { createToolClient, type ToolClient } from "../modules/tool/ToolClient.js";

export interface ClientOptions {
    socketFactory?: (path: string) => Socket;
    socketPath?: string;
    xdgRuntimeDir?: string;
}

export interface Clients {
    artifact: ArtifactClient;
    close(): void;
    config: ConfigClient;
    instance: InstanceClient;
    mcp: McpClient;
    reconnect(): Promise<void>;
    reverse: ReverseClient;
    runtime: RuntimeClient;
    service: ServiceClient;
    todo: TodoClient;
    tool: ToolClient;
}

export function createClients(options: ClientOptions = {}): Clients {
    const connection = new ClientConnection({
        ...options,
        mode: "persistent",
        peer: "tui",
        mapError: toClientError,
        mapRemoteError: toRemoteError
    });
    return {
        artifact: createArtifactClient(connection),
        close: () => connection.close(),
        config: createConfigClient(connection),
        instance: createInstanceClient(connection),
        mcp: createMcpClient(connection),
        reconnect: async () => await connection.reconnect(),
        reverse: createReverseClient(connection),
        runtime: createRuntimeClient(connection),
        service: createServiceClient(connection),
        todo: createTodoClient(connection),
        tool: createToolClient(connection)
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
