import { asInstanceName } from "../../types/Instance.js";
import type { JsonValue } from "../../types/Json.js";
import { controlErrorCodes } from "../../types/Error.js";
import { createRemoteError } from "../../transport/Error.js";
import type { Endpoint } from "../../transport/endpoint/Endpoint.js";
import { createPortClient } from "../../transport/endpoint/PortClient.js";
import {
    routeModule,
    type ControlPortDefinition,
} from "../../control/server/Route.js";
import type { ToolCallApi, ToolCallIngressPort } from "./Api.js";
import type { ToolCallContext, ToolCallPresentation } from "./Type.js";
import {
    receiveToolCallResult,
    ToolCallCallbackServer,
    toolCallFailureEnvelope,
} from "./TargetTransport.js";

/** Control-owned callers enter the Instance pipeline before Review/Rewrite. */
export function createToolCallIngressTransport(
    endpoint: Endpoint,
): ToolCallIngressPort {
    return {
        call: async (
            instance,
            toolName,
            input,
            context,
            signal,
            transformResult,
            invocationInput,
            onProgress,
            recording = "host",
        ) => {
            await endpoint.connect(asInstanceName(instance), "tool", signal);
            const stream = await createPortClient(
                endpoint,
                asInstanceName(instance),
                "tool",
            ).open("ingress", {
                callbacks: {
                    invocationInput: invocationInput !== undefined,
                    transformResult: transformResult !== undefined,
                },
                context,
                input,
                recording,
                toolName,
            });
            return await receiveToolCallResult(stream, {
                invocationInput,
                onProgress,
                signal,
                transformResult,
            });
        },
    };
}

/** The trusted host is wired by Control, never supplied by the tool caller. */
export function createToolCallIngressTransportRoute(
    ingress: ToolCallIngressPort,
    controlHost: string,
): ControlPortDefinition {
    return routeModule(
        "tool",
        {},
        {
            ingress: async (stream, request, route) => {
                if (
                    route.sourceHost !== controlHost ||
                    route.peer !== "cli" ||
                    route.subject?.kind !== "local-owner"
                ) {
                    throw createRemoteError({
                        code: controlErrorCodes.clientIdentityInvalid,
                        message:
                            "ToolCall ingress requires the Control internal connection.",
                        retryable: false,
                    });
                }
                const opened = readIngress(request.payload);
                const callbacks = new ToolCallCallbackServer(stream);
                const signal = AbortSignal.any([
                    route.signal,
                    callbacks.signal,
                ]);
                let progressTail = Promise.resolve();
                const onProgress = (progress: JsonValue) => {
                    progressTail = progressTail.then(() =>
                        stream.send({ name: "progress", payload: progress }),
                    );
                };
                const transformResult: Parameters<ToolCallApi["call"]>[5] =
                    opened.callbacks.transformResult
                        ? async (
                              result,
                              callId,
                              presentation?: ToolCallPresentation,
                          ) =>
                              await callbacks.call("transformResult", {
                                  callId,
                                  result,
                                  ...(presentation === undefined
                                      ? {}
                                      : { presentation }),
                              } as unknown as JsonValue)
                        : undefined;
                const invocationInput: Parameters<ToolCallApi["call"]>[6] =
                    opened.callbacks.invocationInput
                        ? async (input, callId, finalValue) =>
                              await callbacks.call("invocationInput", {
                                  callId,
                                  finalValue,
                                  input,
                              } as unknown as JsonValue)
                        : undefined;
                try {
                    const result = await ingress.call(
                        route.host,
                        opened.toolName,
                        opened.input,
                        opened.context,
                        signal,
                        transformResult,
                        invocationInput,
                        onProgress,
                        opened.recording,
                    );
                    await progressTail;
                    await stream.close({ ok: true, result });
                } catch (error) {
                    await progressTail.catch(() => undefined);
                    await stream.close(toolCallFailureEnvelope(error));
                } finally {
                    callbacks.close();
                }
            },
        },
    );
}

function readIngress(value: unknown): {
    callbacks: { invocationInput: boolean; transformResult: boolean };
    context: ToolCallContext;
    input: JsonValue;
    recording: "host" | "caller";
    toolName: string;
} {
    const input = record(value);
    const callbacks = record(input?.callbacks);
    const context = record(input?.context);
    if (
        input === undefined ||
        callbacks === undefined ||
        context === undefined ||
        typeof input.toolName !== "string" ||
        input.toolName.length === 0 ||
        input.input === undefined ||
        (input.recording !== "host" && input.recording !== "caller") ||
        typeof callbacks.invocationInput !== "boolean" ||
        typeof callbacks.transformResult !== "boolean" ||
        !["mcp", "extension"].includes(String(context.source))
    )
        throw new TypeError("Invalid ToolCall ingress request.");
    for (const key of [
        "requestId",
        "operationId",
        "ctxId",
        "extensionId",
        "workspace",
        "principal",
    ])
        if (context[key] !== undefined && typeof context[key] !== "string")
            throw new TypeError(`Invalid ToolCall ingress context ${key}.`);
    if (
        context.contextMode !== undefined &&
        context.contextMode !== "explicit" &&
        context.contextMode !== "openai-session"
    )
        throw new TypeError("Invalid ToolCall ingress context mode.");
    if (
        context.externalBindings !== undefined &&
        (!Array.isArray(context.externalBindings) ||
            context.externalBindings.some((binding: unknown) => {
                const entry = record(binding);
                return (
                    typeof entry?.kind !== "string" ||
                    typeof entry.value !== "string"
                );
            }))
    )
        throw new TypeError("Invalid ToolCall ingress external bindings.");
    return {
        callbacks: {
            invocationInput: callbacks.invocationInput,
            transformResult: callbacks.transformResult,
        },
        context: context as unknown as ToolCallContext,
        input: input.input as JsonValue,
        recording: input.recording,
        toolName: input.toolName,
    };
}

function record(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}
