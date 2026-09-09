import { isAbsolute } from "node:path";

import type {
    CliCommandInvocationContext,
    CliCommandResult
} from "@portable-devshell/extension/cli";
import {
    createError,
    errorCodes,
    toControlErrorBody,
    type CliCommandDescriptor,
    type CliCommandWireResult,
    type JsonValue,
    type PrefixRouteContext,
    type PrefixRouteModuleDefinition
} from "@portable-devshell/shared";

import { routeModule } from "../../route/ControlRouteFactory.js";
import { CliCommandStreamIo } from "./CliCommandStreamIo.js";
import type { CliExtensionCommandIo } from "./CliExtensionCommandProvider.js";

export interface CliCommandPort {
    command(
        commandId: string,
        argv: readonly string[],
        context: CliCommandInvocationContext,
        io?: CliExtensionCommandIo
    ): Promise<CliCommandResult>;
    list(): readonly CliCommandDescriptor[];
}

export function createCliRouteModule(port: CliCommandPort): PrefixRouteModuleDefinition {
    return routeModule("cli", {
        commands: (_request, context) => {
            requireCli(context);
            return [...port.list()] as unknown as JsonValue;
        },
        command: async (request, context) => {
            requireCli(context);
            const input = readAuthorizedCommand(request.payload, context);
            return assertCommandResult(await port.command(
                input.commandId,
                input.argv,
                invocationContext(input, context)
            ), input.commandId) as unknown as JsonValue;
        },
        commandStream: async (request, context) => {
            requireCli(context);
            const input = readAuthorizedCommand(request.payload, context);
            const io = new CliCommandStreamIo();
            const streamAbort = new AbortController();
            const stream = await context.openStream(
                { accepted: true },
                {
                    onClose: () => {
                        io.closeInput();
                        streamAbort.abort(new Error("CLI command stream was closed by the client."));
                    },
                    onEvent: (event) => io.accept(event)
                }
            );
            io.bind(stream);
            try {
                const result = assertCommandResult(await port.command(
                    input.commandId,
                    input.argv,
                    invocationContext(input, context, streamAbort.signal),
                    io
                ), input.commandId);
                await stream.complete(result as unknown as JsonValue);
            } catch (error) {
                const body = toControlErrorBody(error) ?? createError({
                    code: errorCodes.controlCliCommandFailed,
                    details: { commandId: input.commandId },
                    message: `CLI command ${input.commandId} failed.`,
                    retryable: false
                }).toBody();
                await stream.cancel(body).catch(() => undefined);
            } finally {
                io.closeInput();
            }
            return undefined;
        }
    });
}

function readAuthorizedCommand(
    payload: JsonValue | undefined,
    context: PrefixRouteContext
): ReturnType<typeof readCommand> {
    const input = readCommand(payload);
    const localOwner = isLocalOwnerCli(context);
    if (input.workingDirectory !== undefined && !localOwner) {
        throw createError({
            code: errorCodes.controlCliAccessDenied,
            message: "CLI command workingDirectory is restricted to the local owner CLI.",
            retryable: false
        });
    }
    return input;
}

function invocationContext(
    input: ReturnType<typeof readCommand>,
    context: PrefixRouteContext,
    streamSignal?: AbortSignal
): CliCommandInvocationContext {
    return Object.freeze({
        localOwner: isLocalOwnerCli(context),
        requestId: context.requestId,
        signal: streamSignal === undefined
            ? context.signal
            : AbortSignal.any([context.signal, streamSignal]),
        ...(input.workingDirectory === undefined ? {} : {
            workingDirectory: input.workingDirectory
        })
    });
}

function requireCli(context: PrefixRouteContext): void {
    if (context.peer === "cli") return;
    throw createError({
        code: errorCodes.controlCliAccessDenied,
        message: "CLI command access is available only to CLI clients.",
        retryable: false
    });
}

function isLocalOwnerCli(context: PrefixRouteContext): boolean {
    return context.peer === "cli" && context.subject?.kind === "local-owner";
}

function readCommand(payload: JsonValue | undefined): {
    argv: string[];
    commandId: string;
    workingDirectory?: string;
} {
    const value = readRecord(payload, "cli.command");
    assertOnlyKeys(value, ["argv", "commandId", "workingDirectory"], "cli.command");
    if (!Array.isArray(value.argv) || value.argv.some((candidate) => typeof candidate !== "string")) {
        throw invalid("cli.command argv must be an array of strings.");
    }
    if (
        value.workingDirectory !== undefined &&
        (typeof value.workingDirectory !== "string" || !isAbsolute(value.workingDirectory))
    ) {
        throw invalid("cli.command workingDirectory must be an absolute path.");
    }
    return {
        argv: [...value.argv] as string[],
        commandId: readCommandId(value.commandId),
        ...(value.workingDirectory === undefined ? {} : { workingDirectory: value.workingDirectory })
    };
}

function readCommandId(value: JsonValue | undefined): string {
    if (typeof value === "string" && /^[a-z][a-z0-9-]*$/u.test(value)) return value;
    throw invalid("commandId must match [a-z][a-z0-9-]*.");
}

function readRecord(payload: JsonValue | undefined, operation: string): Record<string, JsonValue> {
    if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) return payload;
    throw invalid(`${operation} requires an object payload.`);
}

function assertOnlyKeys(value: Record<string, JsonValue>, keys: readonly string[], operation: string): void {
    const allowed = new Set(keys);
    const unknown = Object.keys(value).find((key) => !allowed.has(key));
    if (unknown !== undefined) throw invalid(`${operation} contains unknown field ${unknown}.`);
}

function assertCommandResult(value: CliCommandResult, commandId: string): CliCommandWireResult {
    if (value.kind === "text" && typeof value.text === "string") {
        return { kind: "text", text: value.text };
    }
    if (value.kind === "json") {
        return { kind: "json", value: assertJsonValue(value.value, `CLI command ${commandId} result`) };
    }
    throw createError({
        code: errorCodes.controlCliCommandFailed,
        details: { commandId },
        message: `CLI command ${commandId} returned an invalid result.`,
        retryable: false
    });
}

function assertJsonValue(value: unknown, label: string): JsonValue {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (Array.isArray(value)) return value.map((candidate) => assertJsonValue(candidate, label));
    if (typeof value === "object" && value !== null) {
        const result: Record<string, JsonValue> = {};
        for (const [key, candidate] of Object.entries(value)) {
            if (candidate === undefined) {
                throw createError({
                    code: errorCodes.controlCliCommandFailed,
                    message: `${label} is not JSON serializable.`,
                    retryable: false
                });
            }
            result[key] = assertJsonValue(candidate, label);
        }
        return result;
    }
    throw createError({
        code: errorCodes.controlCliCommandFailed,
        message: `${label} is not JSON serializable.`,
        retryable: false
    });
}

function invalid(message: string): Error {
    return createError({
        code: errorCodes.controlCliCommandInvalid,
        message,
        retryable: false
    });
}
