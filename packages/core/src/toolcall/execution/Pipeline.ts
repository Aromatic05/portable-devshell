import { randomUUID } from "node:crypto";

import {
    asInstanceName,
    createRemoteError,
    runtimeErrorCodes,
    type InstanceName,
    type JsonValue,
    type ToolCallContext,
    type ToolCallPresentation,
} from "@portable-devshell/shared";

import { throwIfToolCallAborted } from "./Error.js";
import {
    interpretTerminalValue,
    runOutboundPipeline,
} from "./hook/Outbound.js";
import type {
    ToolCallHookContext,
    ToolCallHookValue,
} from "./hook/Review.js";
import {
    ToolCallHookSequence,
    type ToolCallHookProvider,
} from "./hook/Sequence.js";
import { snapshotJson } from "./hook/Snapshot.js";
import type { ToolCallApi } from "./Api.js";
import type { ToolCallExecutor } from "../registration/Api.js";


export interface ToolCallDispatchRequest {
    readonly callId: string;
    readonly execute?: ToolCallExecutor;
    readonly hooks: ToolCallHookSequence;
    readonly invocationInput?: (
        input: JsonValue,
        callId: string,
        finalValue: ToolCallHookValue,
    ) => Promise<JsonValue> | JsonValue;
    readonly onProgress?: (progress: JsonValue) => void;
    readonly recording: "caller" | "host";
    readonly signal?: AbortSignal;
    readonly transformResult?: (
        result: JsonValue,
        callId: string,
        presentation?: ToolCallPresentation,
    ) => Promise<JsonValue>;
    readonly value: ToolCallHookValue;
}

export interface ToolCallTarget {
    dispatch(request: ToolCallDispatchRequest): Promise<JsonValue>;
}

export type ToolCallTargetResolver = (instance: InstanceName) => ToolCallTarget;

export interface ToolCallPipelineOptions {
    hooks: ToolCallHookProvider;
    resolveExecute?: (toolName: string) => ToolCallExecutor | undefined;
    resolveTarget: ToolCallTargetResolver;
}

export class ToolCallPipeline implements ToolCallApi {
    readonly #hooks: ToolCallHookProvider;
    readonly #resolveExecute?: ToolCallPipelineOptions["resolveExecute"];
    readonly #resolveTarget: ToolCallTargetResolver;

    constructor(options: ToolCallPipelineOptions) {
        this.#hooks = options.hooks;
        this.#resolveExecute = options.resolveExecute;
        this.#resolveTarget = options.resolveTarget;
    }

    async call(
        instance: string,
        toolName: string,
        input: JsonValue,
        context: ToolCallContext,
        signal?: AbortSignal,
        transformResult?: (
            result: JsonValue,
            callId: string,
            presentation?: ToolCallPresentation,
        ) => Promise<JsonValue>,
        invocationInput?: (
            input: JsonValue,
            callId: string,
            finalValue: ToolCallHookValue,
        ) => Promise<JsonValue> | JsonValue,
        onProgress?: (progress: JsonValue) => void,
        recording: "caller" | "host" = "host",
    ): Promise<JsonValue> {
        return await this.#route(
            instance,
            toolName,
            input,
            context,
            signal,
            transformResult,
            invocationInput,
            onProgress,
            recording,
        );
    }

    async #route(
        instance: string,
        toolName: string,
        input: JsonValue,
        context: ToolCallContext,
        signal: AbortSignal | undefined,
        transformResult:
            | ((
                  result: JsonValue,
                  callId: string,
                  presentation?: ToolCallPresentation,
              ) => Promise<JsonValue>)
            | undefined,
        invocationInput:
            | ((
                  input: JsonValue,
                  callId: string,
                  finalValue: ToolCallHookValue,
              ) => Promise<JsonValue> | JsonValue)
            | undefined,
        onProgress: ((progress: JsonValue) => void) | undefined,
        recording: "caller" | "host",
    ): Promise<JsonValue> {
        throwIfToolCallAborted(signal);

        const callId = randomUUID();
        const canonicalInput = snapshotJson(input);
        const canonicalContext = Object.freeze({ ...context });
        const hookSignal = signal ?? new AbortController().signal;
        const hookContext: ToolCallHookContext = Object.freeze({
            ...canonicalContext,
            instance: asInstanceName(instance),
        });
        let hookValue: ToolCallHookValue = {
            context: hookContext,
            kind: "call",
            payload: canonicalInput,
            toolName,
        };

        const hookLease = await this.#hooks(hookContext, hookSignal, recording);
        const hooks = hookLease.sequence;

        try {
            const review = await hooks.review({
                callId,
                direction: "inbound",
                value: hookValue,
            });

            if (review.decision === "reject") {
                const rejectionMessage =
                    review.reason ??
                    `Tool call ${hookValue.toolName} was rejected by review.`;
                const rejectionCause =
                    review.error === undefined
                        ? undefined
                        : createRemoteError({
                              code: review.error.code,
                              ...(review.error.details === undefined
                                  ? {}
                                  : { details: review.error.details }),
                              message: rejectionMessage,
                              retryable: false,
                          });
                const error = createRemoteError({
                    code: runtimeErrorCodes.toolCallRejected,
                    ...(rejectionCause === undefined
                        ? {}
                        : { cause: rejectionCause }),
                    details: {
                        ...(review.reason === undefined
                            ? {}
                            : { reason: review.reason }),
                        toolName: hookValue.toolName,
                    },
                    message: rejectionMessage,
                    retryable: false,
                });
                throw error;
            }

            hookValue = await hooks.rewrite({
                callId,
                direction: "inbound",
                value: hookValue,
            });

            if (hookValue.kind !== "call") {
                hookValue = await runOutboundPipeline(hooks, {
                    callId,
                    direction: "outbound",
                    value: hookValue,
                });
                const interpreted = await interpretTerminalValue(
                    hookValue,
                    onProgress,
                );
                if (interpreted.error !== undefined) throw interpreted.error;
                return interpreted.result!;
            }

            const target = this.#resolveTarget(hookValue.context.instance);
            const execute = this.#resolveExecute?.(hookValue.toolName);
            return await target.dispatch({
                callId,
                ...(execute === undefined ? {} : { execute }),
                hooks,
                ...(invocationInput === undefined ? {} : { invocationInput }),
                ...(onProgress === undefined ? {} : { onProgress }),
                recording,
                ...(signal === undefined ? {} : { signal }),
                ...(transformResult === undefined ? {} : { transformResult }),
                value: hookValue,
            });
        } finally {
            hookLease.release();
        }
    }
}
