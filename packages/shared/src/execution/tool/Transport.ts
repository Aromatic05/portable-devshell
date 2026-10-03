// Thin typed tool transport. The route host supplies the initial instance;
// the tool-call pipeline may still rewrite the instance before final dispatch.
// callStream relays progress messages and resolves with the terminal payload.

import type { Endpoint } from "../../transport/endpoint/Endpoint.js";
import {
    createPortClient,
    type PortClient,
} from "../../transport/endpoint/PortClient.js";
import type { MessageStream } from "../../transport/packet/Stream.js";
import type { JsonValue } from "../../types/Json.js";
import { asInstanceName } from "../../types/Instance.js";
import {
    type EventStreamEnvelope,
    InstanceEventStream,
    type InstanceEventStreamPort,
} from "../../client/Stream.js";
import type {
    ToolCallQuery,
    ToolCallRecord,
    ToolEvent,
    ToolSessionOpenResult,
} from "./Model.js";

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
    listCalls(
        instance: string,
        query?: ToolCallQuery,
    ): Promise<ToolCallRecord[]>;
    openSession(
        instance: string,
        workspace: string,
    ): Promise<ToolSessionOpenResult>;
    subscribe(
        instance: string,
        fromSeq: number,
    ): Promise<InstanceEventStreamPort<ToolEvent>>;
}

export function createToolTransport(endpoint: Endpoint): ToolTransport {
    const port = (instance: string): PortClient =>
        createPortClient(endpoint, instance, "tool");
    return {
        call: (instance, toolName, input, workspace) =>
            port(instance).request<JsonValue>("call", {
                input,
                toolName,
                workspace,
            }),
        callStreaming: async (
            instance,
            toolName,
            input,
            workspace,
            options = {},
        ) => {
            const stream = await port(instance).open("callStream", {
                input,
                ...(options.operationId === undefined
                    ? {}
                    : { operationId: options.operationId }),
                ...(options.recording === undefined
                    ? {}
                    : { recording: options.recording }),
                toolName,
                workspace,
            } satisfies JsonValue);
            return await streamToolCall(stream, options);
        },
        closeSession: (instance) =>
            port(instance).request<Record<string, never>>("closeSession", {}),
        listCalls: (instance, query) =>
            port(instance).request<ToolCallRecord[]>("listCalls", query),
        openSession: (instance, workspace) =>
            port(instance).request<ToolSessionOpenResult>("openSession", {
                workspace,
            }),
        subscribe: async (instance, fromSeq) =>
            new InstanceEventStream<ToolEvent>(
                asInstanceName(instance),
                await port(instance).open("subscribe", { fromSeq }),
            ),
    };
}
async function streamToolCall(
    stream: MessageStream,
    options: ToolCallOptions,
): Promise<JsonValue> {
    const offData = stream.onData((message) => {
        const envelope = message as EventStreamEnvelope;
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
