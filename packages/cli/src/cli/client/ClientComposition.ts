import type { Socket } from "node:net";

import {
    ClientConnection,
    type ControlErrorBody
} from "@portable-devshell/shared";

import { createArtifactClient, type ArtifactClient } from "../modules/artifact/ArtifactClient.js";
import { createInstanceClient, type InstanceClient } from "../modules/instance/InstanceClient.js";
import { createReverseClient, type ReverseClient } from "../modules/reverse/ReverseClient.js";
import { createRuntimeClient, type RuntimeClient } from "../modules/runtime/RuntimeClient.js";
import { createTodoClient, type TodoClient } from "../modules/todo/TodoClient.js";
import { createToolClient, type ToolClient } from "../modules/tool/ToolClient.js";
import { CliRenderError } from "../render/CliRenderError.js";

export interface ClientOptions {
    socketFactory?: (path: string) => Socket;
    socketPath?: string;
    xdgRuntimeDir?: string;
}

export interface Clients {
    artifact: ArtifactClient;
    instance: InstanceClient;
    reverse: ReverseClient;
    runtime: RuntimeClient;
    todo: TodoClient;
    tool: ToolClient;
}

export function createClients(options: ClientOptions = {}): Clients {
    const connection = new ClientConnection({
        ...options,
        mode: "short",
        peer: "cli",
        mapError: toClientError,
        mapRemoteError: toRemoteError
    });
    return {
        artifact: createArtifactClient(connection),
        instance: createInstanceClient(connection),
        reverse: createReverseClient(connection),
        runtime: createRuntimeClient(connection),
        todo: createTodoClient(connection),
        tool: createToolClient(connection)
    };
}

function toRemoteError(error: ControlErrorBody): Error {
    return new CliRenderError(error.code, error.message, {
        cause: error.cause,
        details: error.details,
        retryable: error.retryable
    });
}

function toClientError(error: unknown): Error {
    if (error instanceof CliRenderError) {
        return error;
    }
    if (typeof error === "object" && error !== null && "code" in error) {
        const code = String(error.code);
        if (code === "ENOENT" || code === "ECONNREFUSED") {
            return new CliRenderError("control.notRunning", "control server is not running.");
        }
    }
    return error instanceof Error ? error : new CliRenderError("control.notRunning", String(error));
}
