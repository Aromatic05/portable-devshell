import type { Socket } from "node:net";

import {
    ClientConnection,
    type ControlErrorBody
} from "@portable-devshell/shared";

import { createCliClientArtifact, type CliClientArtifact } from "./artifact/CliClientArtifact.js";
import { createCliClientInstance, type CliClientInstance } from "./instance/CliClientInstance.js";
import { createCliClientReverse, type CliClientReverse } from "../client/reverse/CliClientReverse.js";
import { createCliClientRuntime, type CliClientRuntime } from "./runtime/CliClientRuntime.js";
import { createCliClientTodo, type CliClientTodo } from "./todo/CliClientTodo.js";
import { createCliClientTool, type CliClientTool } from "./tool/CliClientTool.js";
import { CliRenderError } from "../render/CliRenderError.js";

export interface CliClientOptions {
    socketFactory?: (path: string) => Socket;
    socketPath?: string;
    xdgRuntimeDir?: string;
}

export interface CliClients {
    artifact: CliClientArtifact;
    instance: CliClientInstance;
    reverse: CliClientReverse;
    runtime: CliClientRuntime;
    todo: CliClientTodo;
    tool: CliClientTool;
}

export function createCliClients(options: CliClientOptions = {}): CliClients {
    const connection = new ClientConnection({
        ...options,
        mode: "short",
        peer: "cli",
        mapError: toClientError,
        mapRemoteError: toRemoteError
    });
    return {
        artifact: createCliClientArtifact(connection),
        instance: createCliClientInstance(connection),
        reverse: createCliClientReverse(connection),
        runtime: createCliClientRuntime(connection),
        todo: createCliClientTodo(connection),
        tool: createCliClientTool(connection)
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
