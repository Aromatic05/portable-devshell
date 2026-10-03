// Thin typed tool transport. call/callStream run against the Control tool port
// so every client shares one pipeline; session and call-history reads target
// the instance tool port. callStream relays progress messages and resolves with
// the terminal stream payload.

import type { Endpoint } from "../../transport/endpoint/Endpoint.js";
import { Rpc } from "../../transport/packet/Rpc.js";
import { Stream, type MessageStream } from "../../transport/packet/Stream.js";
import type { JsonValue } from "../../transport/primitive/JsonValue.js";
import type { InstanceStreamEnvelope } from "../activity/Contract.js";
import {
    toolOperations,
    type ToolOperation,
    type ToolRequest,
    type ToolResponse,
} from "./Contract.js";
import type {
    ToolCallQuery,
    ToolCallRecord,
    ToolSessionOpenResult,
} from "./Model.js";

export const TOOL_HOST = "@control";
export const TOOL_PORT = "tool";

export interface ToolCallOptions {
    onProgress?(progress: JsonValue): void;
    operationId?: string;
    recording?: "caller" | "host";
    signal?: AbortSignal;
}

export interface ToolTransport {
    call(
        instance: string,
        toolName: string,
        input: JsonValue,
        workspace: string,
    ): Promise<JsonValue>;
    callStreaming(
        instance: string,
        toolName: string,
        input: JsonValue,
        workspace: string,
        options?: ToolCallOptions,
    ): Promise<JsonValue>;
    closeSession(instance: string): Promise<Record<string, never>>;
    listCalls(instance: string, query?: ToolCallQuery): Promise<ToolCallRecord[]>;
    openSession(
        instance: string,
        workspace: string,
    ): Promise<ToolSessionOpenResult>;
}

export function createToolTransport(endpoint: Endpoint): ToolTransport {
    const controlRequest = async <Operation extends ToolOperation>(
        operation: Operation,
        payload: ToolRequest<Operation>,
    ): Promise<ToolResponse<Operation>> => {
        const rpc = new Rpc(await endpoint.connect(TOOL_HOST, TOOL_PORT));
        try {
            return await rpc.request<ToolResponse<Operation>>(
                operation,
                payload,
            );
        } finally {
            rpc.close();
        }
    };
    const instanceRequest = async <Operation extends ToolOperation>(
        instance: string,
        operation: Operation,
        payload: ToolRequest<Operation>,
    ): Promise<ToolResponse<Operation>> => {
        const rpc = new Rpc(await endpoint.connect(instance, TOOL_PORT));
        try {
            return await rpc.request<ToolResponse<Operation>>(
                operation,
                payload,
            );
        } finally {
            rpc.close();
        }
    };
    return {
        call: (instance, toolName, input, workspace) =>
            controlRequest(toolOperations.call, {
                instance,
                input,
                toolName,
                workspace,
            }),
        callStreaming: async (instance, toolName, input, workspace, options = {}) => {
            const protocol = new Stream(
                await endpoint.connect(TOOL_HOST, TOOL_PORT),
            );
            const stream = await protocol.open(
                toolOperations.callStream,
                {
                    instance,
                    input,
                    ...(options.operationId === undefined
                        ? {}
                        : { operationId: options.operationId }),
                    ...(options.recording === undefined
                        ? {}
                        : { recording: options.recording }),
                    toolName,
                    workspace,
                } satisfies JsonValue,
            );
            const close = () => protocol.close();
            stream.onClose(close);
            stream.onCancel(close);
            return await streamToolCall(stream, options);
        },
        closeSession: (instance) =>
            instanceRequest(instance, toolOperations.closeSession, {}),
        listCalls: (instance, query) =>
            instanceRequest(instance, toolOperations.listCalls, query),
        openSession: (instance, workspace) =>
            instanceRequest(instance, toolOperations.openSession, { workspace }),
    };
}

async function streamToolCall(
    stream: MessageStream,
    options: ToolCallOptions,
): Promise<JsonValue> {
    const offData = stream.onData((message) => {
        const envelope = message as InstanceStreamEnvelope;
        if (envelope.name === "progress")
            options.onProgress?.(envelope.payload ?? null);
    });
    const aborted = () => {
        void stream.cancel({
            message:
                options.signal?.reason instanceof Error
                    ? options.signal.reason.message
                    : "Tool call was aborted.",
        });
    };
    options.signal?.addEventListener("abort", aborted, { once: true });
    if (options.signal?.aborted === true) aborted();
    try {
        return await streamTerminal(stream);
    } finally {
        offData();
        options.signal?.removeEventListener("abort", aborted);
    }
}

function streamTerminal(stream: MessageStream): Promise<JsonValue> {
    return new Promise((resolve, reject) => {
        stream.onClose((message) => resolve((message ?? null) as JsonValue));
        stream.onCancel((error) =>
            reject(
                error === undefined
                    ? new Error("Stream cancelled.")
                    : Object.assign(new Error(error.message), {
                          ...(error.code === undefined
                              ? {}
                              : { code: error.code }),
                          ...(error.details === undefined
                              ? {}
                              : { details: error.details }),
                          ...(error.retryable === undefined
                              ? {}
                              : { retryable: error.retryable }),
                      }),
            ),
        );
    });
}
