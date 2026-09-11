import { matchesGlob } from "node:path";

import type {
    ExtensionContext,
    ExtensionJsonValue,
    ExtensionWorkerSession
} from "@portable-devshell/extension";
import type {
    CliCommandResult,
    CliModelCommandInvocationContext
} from "@portable-devshell/extension/cli";

import { scanSecretText, type SecretScanFinding } from "./SecretScan.js";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1_000;
const MAX_FILES = 20_000;
const READ_BATCH = 32;

export const SECRET_MODEL_USAGE = [
    "Usage:",
    "  devshell secret scan [directory] [--glob <pattern>] [--limit <n>]",
    "",
    "Scans files inside the current model Workspace and never returns matched secret values."
].join("\n");

export async function executeSecretModelCommand(
    extension: ExtensionContext,
    argv: readonly string[],
    invocation: CliModelCommandInvocationContext
): Promise<CliCommandResult> {
    invocation.signal.throwIfAborted();
    if (argv.length === 0 || ["help", "--help", "-h"].includes(argv[0] ?? "")) {
        if (argv.length > 1) throw usageError("secret help does not accept extra arguments");
        return { kind: "text", text: SECRET_MODEL_USAGE };
    }
    if (argv[0] !== "scan") throw usageError(`Unknown secret command: ${argv[0]}`);
    const parsed = parseArgs(argv.slice(1));
    const workers = extension.capabilities.workers;
    if (workers === undefined) throw new Error("Secret Extension model commands require the workers capability.");
    const session = await workers.openSession({ instance: invocation.instance, workspace: invocation.workspace });
    try {
        return json(await scanRemote(session, parsed, invocation.signal));
    } finally {
        await session.close();
    }
}

async function scanRemote(
    session: ExtensionWorkerSession,
    options: { directory: string; glob?: string; limit: number },
    signal: AbortSignal
): Promise<{ findings: SecretScanFinding[]; truncated: boolean; truncatedFiles: number }> {
    const root = normalizeDirectory(options.directory);
    const paths: string[] = [];
    let nextCursor: string | undefined;
    do {
        signal.throwIfAborted();
        const result = asRecord(await session.callTool("file_glob", nextCursor === undefined
            ? { patterns: [`${root === "." ? "./" : `${root}/`}**/*`], type: "file" }
            : { cursor: nextCursor }, { signal }));
        for (const entry of Array.isArray(result.entries) ? result.entries : []) {
            const value = asRecord(entry);
            if (typeof value.path !== "string") continue;
            if (options.glob !== undefined && !matchesGlob(displayPath(value.path, root), options.glob)) continue;
            paths.push(value.path);
            if (paths.length >= MAX_FILES) break;
        }
        nextCursor = paths.length >= MAX_FILES || typeof result.nextCursor !== "string"
            ? undefined
            : result.nextCursor;
    } while (nextCursor !== undefined);

    const findings: SecretScanFinding[] = [];
    let truncatedFiles = 0;
    for (let offset = 0; offset < paths.length && findings.length < options.limit; offset += READ_BATCH) {
        const batch = paths.slice(offset, offset + READ_BATCH);
        const result = asRecord(await session.callTool("file_read", {
            files: batch.map((path) => ({ path }))
        }, { signal }));
        for (const entry of Array.isArray(result.files) ? result.files : []) {
            const value = asRecord(entry);
            if (typeof value.path !== "string" || typeof value.content !== "string") continue;
            if (value.truncated === true) truncatedFiles += 1;
            const remaining = options.limit - findings.length;
            findings.push(...scanSecretText(displayPath(value.path, root), stripLineNumbers(value.content), remaining));
            if (findings.length >= options.limit) break;
        }
    }
    return {
        findings,
        truncated: paths.length >= MAX_FILES || findings.length >= options.limit,
        truncatedFiles
    };
}

function parseArgs(args: readonly string[]): { directory: string; glob?: string; limit: number } {
    let directory = ".";
    let glob: string | undefined;
    let limit = DEFAULT_LIMIT;
    let pathSeen = false;
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index]!;
        if (argument === "--glob") {
            glob = requireOption(args, ++index, "--glob");
            continue;
        }
        if (argument === "--limit") {
            const raw = requireOption(args, ++index, "--limit");
            if (!/^\d+$/u.test(raw)) throw usageError("secret scan --limit requires a positive integer");
            limit = Math.min(Number(raw), MAX_LIMIT);
            if (limit < 1) throw usageError("secret scan --limit requires a positive integer");
            continue;
        }
        if (argument.startsWith("-")) throw usageError(`Unknown secret scan option: ${argument}`);
        if (pathSeen) throw usageError("secret scan accepts at most one directory");
        directory = argument;
        pathSeen = true;
    }
    return { directory, ...(glob === undefined ? {} : { glob }), limit };
}

function normalizeDirectory(value: string): string {
    if (value === "." || value === "./") return ".";
    if (value.startsWith("/") || value.includes("\\")) {
        throw usageError("model secret scan directory must be Workspace-relative");
    }
    const parts = value.replace(/^\.\//u, "").split("/");
    if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
        throw usageError("model secret scan directory must stay inside the Workspace");
    }
    return `./${parts.join("/")}`;
}

function displayPath(path: string, root: string): string {
    if (root === ".") return path.replace(/^\.\//u, "");
    const prefix = `${root}/`;
    return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function stripLineNumbers(content: string): string {
    return content.split("\n").map((line) => line.replace(/^\d+:/u, "")).join("\n");
}

function requireOption(args: readonly string[], index: number, option: string): string {
    const value = args[index];
    if (value === undefined || value.length === 0) throw usageError(`secret scan ${option} requires a value`);
    return value;
}

function asRecord(value: unknown): Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function json(value: unknown): CliCommandResult {
    return { kind: "json", value: value as ExtensionJsonValue };
}

function usageError(message: string): TypeError {
    return new TypeError(`${message}\n\n${SECRET_MODEL_USAGE}`);
}
