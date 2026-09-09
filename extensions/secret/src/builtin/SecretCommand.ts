import { isAbsolute, resolve } from "node:path";

import type { ExtensionJsonValue } from "@portable-devshell/extension";
import type {
    CliNativeCommandInvocationContext,
    CliCommandResult
} from "@portable-devshell/extension/cli";

import { scanSecrets } from "./SecretScan.js";

export const SECRET_USAGE = [
    "Usage:",
    "  devshell secret scan [directory] [--glob <pattern>] [--limit <n>]",
    "",
    "Reports secret type, path, and line only; matched secret values are never returned."
].join("\n");

export async function executeSecretCommand(
    argv: readonly string[],
    invocation: CliNativeCommandInvocationContext
): Promise<CliCommandResult> {
    invocation.signal.throwIfAborted();
    requireLocalOwner(invocation);
    if (argv.length === 0 || ["help", "--help", "-h"].includes(argv[0] ?? "")) {
        if (argv.length > 1) throw usageError("secret help does not accept extra arguments");
        return { kind: "text", text: SECRET_USAGE };
    }
    if (argv[0] !== "scan") throw usageError(`Unknown secret command: ${argv[0]}`);
    const options = parseSecretScanArgs(argv.slice(1), invocation);
    return {
        kind: "json",
        value: await scanSecrets({ ...options, signal: invocation.signal }) as unknown as ExtensionJsonValue
    };
}

function parseSecretScanArgs(
    args: readonly string[],
    invocation: CliNativeCommandInvocationContext
): { cwd: string; glob?: string; limit?: number } {
    let directory = ".";
    let glob: string | undefined;
    let limit: number | undefined;
    let pathSeen = false;
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index]!;
        if (argument === "--glob") {
            glob = requireOption(args, ++index, "--glob");
            continue;
        }
        if (argument === "--limit") {
            const value = requireOption(args, ++index, "--limit");
            if (!/^\d+$/u.test(value)) throw usageError("secret scan --limit requires a positive integer");
            limit = Number(value);
            continue;
        }
        if (argument.startsWith("-")) throw usageError(`Unknown secret scan option: ${argument}`);
        if (pathSeen) throw usageError("secret scan accepts at most one directory");
        directory = argument;
        pathSeen = true;
    }
    const cwd = resolveLocalPath(directory, invocation);
    return { cwd, ...(glob === undefined ? {} : { glob }), ...(limit === undefined ? {} : { limit }) };
}

function resolveLocalPath(path: string, invocation: CliNativeCommandInvocationContext): string {
    if (isAbsolute(path)) return resolve(path);
    if (invocation.workingDirectory === undefined) {
        throw usageError("relative secret scan paths require the local CLI working directory");
    }
    return resolve(invocation.workingDirectory, path);
}

function requireOption(args: readonly string[], index: number, option: string): string {
    const value = args[index];
    if (value === undefined || value.length === 0) throw usageError(`secret scan ${option} requires a value`);
    return value;
}

function requireLocalOwner(invocation: CliNativeCommandInvocationContext): void {
    if (!invocation.localOwner) throw new Error("Secret commands are restricted to the local owner CLI.");
}

function usageError(message: string): TypeError {
    return new TypeError(`${message}\n\n${SECRET_USAGE}`);
}
