import { isAbsolute } from "node:path";

import type {
    CliCommandIo,
    CliCommandResult,
    CliNativeCommandInvocationContext,
} from "@portable-devshell/extension/cli";
import {
    createRemoteError,
    controlErrorCodes,
    toRemoteErrorBody,
    type CliCommandDescriptor,
    type CliCommandWireResult,
    type JsonValue,
    type ControlPortContext,
    type ControlPortDefinition,
    type ControlStreamMessage,
} from "@portable-devshell/shared";

import { routeModule } from "../../server/Route.js";
import { CliCommandStreamIo } from "./command/Io.js";

export interface CliCommandPort {
    command(
        commandId: string,
        argv: readonly string[],
        context: CliNativeCommandInvocationContext,
        io?: CliCommandIo,
    ): Promise<CliCommandResult>;
    list(): readonly CliCommandDescriptor[];
}

export function createCliRouteModule(
    port: CliCommandPort,
): ControlPortDefinition {
    return routeModule(
        "extension",
        {
            cliCommands: (_request, context) => {
                requireCli(context);
                return [...port.list()] as unknown as JsonValue;
            },
            cliCommand: async (request, context) => {
                requireCli(context);
                const input = readAuthorizedCommand(request.payload, context);
                return assertCommandResult(
                    await port.command(
                        input.commandId,
                        input.argv,
                        invocationContext(input, context),
                    ),
                    input.commandId,
                ) as unknown as JsonValue;
            },
        },
        {
            cliCommandStream: async (stream, request, context) => {
                requireCli(context);
                const input = readAuthorizedCommand(request.payload, context);
                const io = new CliCommandStreamIo();
                const offData = stream.onData((message) =>
                    io.accept(message as ControlStreamMessage),
                );
                const offClose = stream.onClose(() => io.closeInput());
                const offCancel = stream.onCancel(() => io.closeInput());
                io.bind(stream);
                try {
                    const result = assertCommandResult(
                        await port.command(
                            input.commandId,
                            input.argv,
                            invocationContext(input, context),
                            io,
                        ),
                        input.commandId,
                    );
                    await stream.close(result as unknown as JsonValue);
                } catch (error) {
                    const body =
                        toRemoteErrorBody(error) ??
                        createRemoteError({
                            code: controlErrorCodes.cliCommandFailed,
                            details: { commandId: input.commandId },
                            message: `CLI command ${input.commandId} failed.`,
                            retryable: false,
                        }).toBody();
                    await stream.cancel(body);
                } finally {
                    offData();
                    offClose();
                    offCancel();
                    io.closeInput();
                }
            },
        },
    );
}

function readAuthorizedCommand(
    payload: JsonValue | undefined,
    context: ControlPortContext,
): ReturnType<typeof readCommand> {
    const input = readCommand(payload);
    const localOwner = isLocalOwnerCli(context);
    if (input.workingDirectory !== undefined && !localOwner) {
        throw createRemoteError({
            code: controlErrorCodes.cliAccessDenied,
            message:
                "CLI command workingDirectory is restricted to the local owner CLI.",
            retryable: false,
        });
    }
    return input;
}

function invocationContext(
    input: ReturnType<typeof readCommand>,
    context: ControlPortContext,
    streamSignal?: AbortSignal,
): CliNativeCommandInvocationContext {
    return Object.freeze({
        localOwner: isLocalOwnerCli(context),
        requestId: context.requestId,
        signal:
            streamSignal === undefined
                ? context.signal
                : AbortSignal.any([context.signal, streamSignal]),
        ...(input.workingDirectory === undefined
            ? {}
            : {
                  workingDirectory: input.workingDirectory,
              }),
    });
}

function requireCli(context: ControlPortContext): void {
    if (context.peer === "cli") return;
    throw createRemoteError({
        code: controlErrorCodes.cliAccessDenied,
        message: "CLI command access is available only to CLI clients.",
        retryable: false,
    });
}

function isLocalOwnerCli(context: ControlPortContext): boolean {
    return context.peer === "cli" && context.subject?.kind === "local-owner";
}

function readCommand(payload: JsonValue | undefined): {
    argv: string[];
    commandId: string;
    workingDirectory?: string;
} {
    const value = readRecord(payload, "cli.command");
    assertOnlyKeys(
        value,
        ["argv", "commandId", "workingDirectory"],
        "cli.command",
    );
    if (
        !Array.isArray(value.argv) ||
        value.argv.some((candidate) => typeof candidate !== "string")
    ) {
        throw invalid("cli.command argv must be an array of strings.");
    }
    if (
        value.workingDirectory !== undefined &&
        (typeof value.workingDirectory !== "string" ||
            !isAbsolute(value.workingDirectory))
    ) {
        throw invalid("cli.command workingDirectory must be an absolute path.");
    }
    return {
        argv: [...value.argv] as string[],
        commandId: readCommandId(value.commandId),
        ...(value.workingDirectory === undefined
            ? {}
            : { workingDirectory: value.workingDirectory }),
    };
}

function readCommandId(value: JsonValue | undefined): string {
    if (typeof value === "string" && /^[a-z][a-z0-9-]*$/u.test(value))
        return value;
    throw invalid("commandId must match [a-z][a-z0-9-]*.");
}

function readRecord(
    payload: JsonValue | undefined,
    operation: string,
): Record<string, JsonValue> {
    if (
        typeof payload === "object" &&
        payload !== null &&
        !Array.isArray(payload)
    )
        return payload;
    throw invalid(`${operation} requires an object payload.`);
}

function assertOnlyKeys(
    value: Record<string, JsonValue>,
    keys: readonly string[],
    operation: string,
): void {
    const allowed = new Set(keys);
    const unknown = Object.keys(value).find((key) => !allowed.has(key));
    if (unknown !== undefined)
        throw invalid(`${operation} contains unknown field ${unknown}.`);
}

function assertCommandResult(
    value: CliCommandResult,
    commandId: string,
): CliCommandWireResult {
    if (value.kind === "text" && typeof value.text === "string") {
        return { kind: "text", text: value.text };
    }
    if (value.kind === "json") {
        if (value.text !== undefined && typeof value.text !== "string") {
            throw createRemoteError({
                code: controlErrorCodes.cliCommandFailed,
                details: { commandId },
                message: `CLI command ${commandId} returned an invalid text rendering.`,
                retryable: false,
            });
        }
        return {
            kind: "json",
            ...(value.text === undefined ? {} : { text: value.text }),
            value: assertJsonValue(
                value.value,
                `CLI command ${commandId} result`,
            ),
        };
    }
    throw createRemoteError({
        code: controlErrorCodes.cliCommandFailed,
        details: { commandId },
        message: `CLI command ${commandId} returned an invalid result.`,
        retryable: false,
    });
}

function assertJsonValue(value: unknown, label: string): JsonValue {
    if (
        value === null ||
        typeof value === "string" ||
        typeof value === "boolean"
    )
        return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (Array.isArray(value))
        return value.map((candidate) => assertJsonValue(candidate, label));
    if (typeof value === "object" && value !== null) {
        const result: Record<string, JsonValue> = {};
        for (const [key, candidate] of Object.entries(value)) {
            if (candidate === undefined) {
                throw createRemoteError({
                    code: controlErrorCodes.cliCommandFailed,
                    message: `${label} is not JSON serializable.`,
                    retryable: false,
                });
            }
            result[key] = assertJsonValue(candidate, label);
        }
        return result;
    }
    throw createRemoteError({
        code: controlErrorCodes.cliCommandFailed,
        message: `${label} is not JSON serializable.`,
        retryable: false,
    });
}

function invalid(message: string): Error {
    return createRemoteError({
        code: controlErrorCodes.cliCommandInvalid,
        message,
        retryable: false,
    });
}
