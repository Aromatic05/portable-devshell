import { isAbsolute } from "node:path";

import {
    controlErrorCodes,
    createRemoteError,
    routeModule,
    toRemoteErrorBody,
    type CodeDescribeRequest,
    type CodeEvalRequest,
    type ControlPortContext,
    type ControlPortDefinition,
    type JsonValue,
} from "@portable-devshell/shared";

import type { CodeExecutionPrincipal, CodePort } from "./Api.js";

export function createCodeRouteModule(port: CodePort): ControlPortDefinition {
    return routeModule(
        "code",
        {
            describe: (request, context) => {
                requireCli(context);
                const parsed = readDescribeRequest(request.payload);
                const principal = buildNativePrincipal(context);
                return port.describe(parsed, principal) as unknown as JsonValue;
            },
        },
        {
            eval: async (stream, request, context) => {
                requireCli(context);
                const parsed = readEvalRequest(request.payload, context);
                const principal = buildNativePrincipal(
                    context,
                    parsed.workingDirectory,
                    parsed.instance,
                    parsed.workspace,
                );
                const cancelController = new AbortController();
                const offCancel = stream.onCancel(() => {
                    cancelController.abort(new Error("Code execution cancelled by client."));
                });
                const signal = AbortSignal.any([
                    context.signal,
                    cancelController.signal,
                ]);
                let logTail = Promise.resolve();
                try {
                    const result = await port.eval(parsed, {
                        onLog: (entry) => {
                            logTail = logTail
                                .catch(() => undefined)
                                .then(async () => {
                                    if (signal.aborted) return;
                                    await stream.send({
                                        name: "log",
                                        payload: entry as unknown as JsonValue,
                                    });
                                });
                        },
                        principal,
                        signal,
                    });
                    await logTail.catch(() => undefined);
                    await stream.close(result as unknown as JsonValue);
                } catch (error) {
                    await logTail.catch(() => undefined);
                    const body =
                        toRemoteErrorBody(error) ??
                        createRemoteError({
                            code: controlErrorCodes.codeEvalFailed,
                            message:
                                error instanceof Error
                                    ? error.message
                                    : "Code execution failed.",
                            retryable: false,
                        }).toBody();
                    await stream.cancel(body);
                } finally {
                    offCancel();
                }
            },
        },
    );
}

function buildNativePrincipal(
    context: ControlPortContext,
    workingDirectory?: string,
    instance?: string,
    workspace?: string,
): CodeExecutionPrincipal {
    return Object.freeze({
        audience: "native",
        ...(instance === undefined ? {} : { instance }),
        localOwner: isLocalOwnerCli(context),
        requestId: context.requestId,
        ...(workingDirectory === undefined ? {} : { workingDirectory }),
        ...(workspace === undefined ? {} : { workspace }),
    });
}

function requireCli(context: ControlPortContext): void {
    if (context.peer === "cli") return;
    throw createRemoteError({
        code: controlErrorCodes.codeAccessDenied,
        message: "Code Mode route access is currently restricted to CLI clients.",
        retryable: false,
    });
}

function isLocalOwnerCli(context: ControlPortContext): boolean {
    return context.peer === "cli" && context.subject?.kind === "local-owner";
}

function readDescribeRequest(payload: JsonValue | undefined): CodeDescribeRequest {
    if (payload === undefined) return {};
    const record = readRecord(payload, "code.describe");
    assertOnlyKeys(record, ["filter", "instance", "target"], "code.describe");
    return {
        ...(readOptionalString(record.filter, "code.describe filter") === undefined
            ? {}
            : { filter: record.filter as string }),
        ...(readOptionalString(record.instance, "code.describe instance") === undefined
            ? {}
            : { instance: record.instance as string }),
        ...(readOptionalString(record.target, "code.describe target") === undefined
            ? {}
            : { target: record.target as string }),
    };
}

function readEvalRequest(
    payload: JsonValue | undefined,
    context: ControlPortContext,
): CodeEvalRequest {
    const record = readRecord(payload, "code.eval");
    assertOnlyKeys(
        record,
        ["filename", "instance", "source", "timeoutMs", "workingDirectory", "workspace"],
        "code.eval",
    );
    if (typeof record.source !== "string") {
        throw invalid("code.eval requires a string source.");
    }
    const filename = readOptionalString(record.filename, "code.eval filename");
    const instance = readOptionalString(record.instance, "code.eval instance");
    const workspace = readOptionalString(record.workspace, "code.eval workspace");
    const workingDirectory = readOptionalString(
        record.workingDirectory,
        "code.eval workingDirectory",
    );
    if (workingDirectory !== undefined) {
        if (!isLocalOwnerCli(context)) {
            throw createRemoteError({
                code: controlErrorCodes.codeAccessDenied,
                message:
                    "code.eval workingDirectory is restricted to the local owner CLI.",
                retryable: false,
            });
        }
        if (!isAbsolute(workingDirectory)) {
            throw invalid("code.eval workingDirectory must be an absolute path.");
        }
    }
    let timeoutMs: number | undefined;
    if (record.timeoutMs !== undefined) {
        if (
            typeof record.timeoutMs !== "number" ||
            !Number.isFinite(record.timeoutMs) ||
            record.timeoutMs <= 0
        ) {
            throw invalid("code.eval timeoutMs must be a positive number.");
        }
        timeoutMs = record.timeoutMs;
    }
    return {
        ...(filename === undefined ? {} : { filename }),
        ...(instance === undefined ? {} : { instance }),
        source: record.source,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(workingDirectory === undefined ? {} : { workingDirectory }),
        ...(workspace === undefined ? {} : { workspace }),
    };
}

function readOptionalString(
    value: JsonValue | undefined,
    label: string,
): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value === "string") return value;
    throw invalid(`${label} must be a string.`);
}

function readRecord(
    payload: JsonValue | undefined,
    operation: string,
): Record<string, JsonValue> {
    if (typeof payload === "object" && payload !== null && !Array.isArray(payload))
        return payload;
    throw invalid(`${operation} requires an object payload.`);
}

function assertOnlyKeys(
    record: Record<string, JsonValue>,
    allowed: readonly string[],
    operation: string,
): void {
    const set = new Set(allowed);
    const extra = Object.keys(record).find((key) => !set.has(key));
    if (extra !== undefined) {
        throw invalid(`${operation} contains unknown field ${extra}.`);
    }
}

function invalid(message: string): Error {
    return createRemoteError({
        code: controlErrorCodes.codeEvalInvalid,
        message,
        retryable: false,
    });
}
