import { isAbsolute, resolve } from "node:path";

import {
    downgradeAuditDatabase,
    downgradeConversationDatabase,
    inspectStorageDatabase,
} from "./StorageDowngrade.js";

export const STORAGE_USAGE = [
    "Usage:",
    "  devshell storage inspect <database>",
    "  devshell storage downgrade audit <database> --to 1 --output <audit-v1.sqlite3>",
    "  devshell storage downgrade conversation <database> --to 0 --output <context-messages.json> [--instance <name>]",
    "",
    "Downgrade never modifies or overwrites the source database or an existing output.",
    "If Control cannot start because the database is newer, use the plugin-owned offline executable: devshell-storage ...",
].join("\n");

export type StorageCommandCoreResult =
    | { kind: "json"; value: unknown }
    | { kind: "text"; text: string };

export function executeStorageArguments(
    argv: readonly string[],
    context: { signal: AbortSignal; workingDirectory?: string },
): StorageCommandCoreResult {
    context.signal.throwIfAborted();
    if (argv.length === 0 || ["help", "--help", "-h"].includes(argv[0] ?? "")) {
        if (argv.length > 1) throw usageError("storage help does not accept extra arguments");
        return { kind: "text", text: STORAGE_USAGE };
    }
    if (argv[0] === "inspect") {
        if (argv.length !== 2) throw usageError("storage inspect requires exactly one database path");
        return {
            kind: "json",
            value: inspectStorageDatabase(resolveLocalPath(argv[1]!, context.workingDirectory)),
        };
    }
    if (argv[0] !== "downgrade") throw usageError(`Unknown storage command: ${argv[0]}`);
    const kind = argv[1];
    if (kind !== "audit" && kind !== "conversation") {
        throw usageError("storage downgrade requires audit or conversation");
    }
    const parsed = parseDowngradeArgs(argv.slice(2), context.workingDirectory);
    const value = kind === "audit"
        ? downgradeAuditDatabase({
            output: parsed.output,
            signal: context.signal,
            source: parsed.source,
            toVersion: parsed.toVersion,
        })
        : downgradeConversationDatabase({
            ...(parsed.instance === undefined ? {} : { instance: parsed.instance }),
            output: parsed.output,
            signal: context.signal,
            source: parsed.source,
            toVersion: parsed.toVersion,
        });
    return { kind: "json", value };
}

function parseDowngradeArgs(
    args: readonly string[],
    workingDirectory: string | undefined,
): { instance?: string; output: string; source: string; toVersion: number } {
    const sourceArg = args[0];
    if (sourceArg === undefined || sourceArg.startsWith("-")) {
        throw usageError("storage downgrade requires a source database path");
    }
    let output: string | undefined;
    let toVersion: number | undefined;
    let instance: string | undefined;
    for (let index = 1; index < args.length; index += 1) {
        const argument = args[index]!;
        if (argument === "--output") {
            output = resolveLocalPath(requireOption(args, ++index, "--output"), workingDirectory);
            continue;
        }
        if (argument === "--to") {
            const value = requireOption(args, ++index, "--to");
            if (!/^\d+$/u.test(value)) throw usageError("storage downgrade --to requires a non-negative integer");
            toVersion = Number(value);
            continue;
        }
        if (argument === "--instance") {
            instance = requireOption(args, ++index, "--instance");
            continue;
        }
        throw usageError(`Unknown storage downgrade option: ${argument}`);
    }
    if (output === undefined) throw usageError("storage downgrade requires --output");
    if (toVersion === undefined) throw usageError("storage downgrade requires --to");
    return {
        ...(instance === undefined ? {} : { instance }),
        output,
        source: resolveLocalPath(sourceArg, workingDirectory),
        toVersion,
    };
}

function resolveLocalPath(path: string, workingDirectory: string | undefined): string {
    if (isAbsolute(path)) return resolve(path);
    if (workingDirectory === undefined) {
        throw usageError("relative storage paths require the local CLI working directory");
    }
    return resolve(workingDirectory, path);
}

function requireOption(args: readonly string[], index: number, option: string): string {
    const value = args[index];
    if (value === undefined || value.length === 0) {
        throw usageError(`storage downgrade ${option} requires a value`);
    }
    return value;
}

function usageError(message: string): TypeError {
    return new TypeError(`${message}\n\n${STORAGE_USAGE}`);
}
