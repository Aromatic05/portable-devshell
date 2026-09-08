import { isAbsolute, resolve } from "node:path";

import type {
    ExtensionAssetTransferResult,
    ExtensionCommandResult,
    ExtensionContext,
    ExtensionInvocationContext,
    ExtensionJsonValue,
    ExtensionWorkerSession
} from "@portable-devshell/extension";

import {
    listSkills,
    loadSkill,
    readSkillFile,
    resolveSkillSource,
    searchSkills,
    type SkillCatalogOptions
} from "./SkillCatalog.js";

const MANAGED_SKILL_RELATIVE_DIRECTORY = ".devshell/skill";

export const SKILL_USAGE = [
    "Usage:",
    "  devshell skill list [--workspace <directory>]",
    "  devshell skill search <query> [--workspace <directory>]",
    "  devshell skill load <name> [--workspace <directory>]",
    "  devshell skill inspect <name> [--workspace <directory>]",
    "  devshell skill read <name> <path> [--workspace <directory>]",
    "  devshell skill get <name> <instance:/workspace> [--workspace <local-directory>]",
    "",
    "Lookup priority: project .agents/skills, managed ~/.devshell/skill, global $XDG_CONFIG_HOME/agents/skills.",
    "get snapshots the selected local Skill, prepares the target managed Skill directory, and transfers it through Artifact."
].join("\n");

export async function executeSkillCommand(
    extension: ExtensionContext,
    argv: readonly string[],
    invocation: ExtensionInvocationContext
): Promise<ExtensionCommandResult> {
    invocation.signal.throwIfAborted();
    requireLocalOwner(invocation);
    if (argv.length === 0 || ["help", "--help", "-h"].includes(argv[0] ?? "")) {
        if (argv.length > 1) throw usageError("skill help does not accept extra arguments");
        return { kind: "text", text: SKILL_USAGE };
    }

    const command = argv[0]!;
    const parsed = parseArgs(argv.slice(1));
    const options = catalogOptions(parsed.workspace, invocation);
    switch (command) {
        case "list":
            expectPositionals(parsed.positionals, 0, "skill list");
            return json(await listSkills(options));
        case "search":
            expectPositionals(parsed.positionals, 1, "skill search <query>");
            return json(await searchSkills(parsed.positionals[0]!, options));
        case "load":
        case "inspect":
            expectPositionals(parsed.positionals, 1, `skill ${command} <name>`);
            return json(await loadSkill(parsed.positionals[0]!, options));
        case "read":
            expectPositionals(parsed.positionals, 2, "skill read <name> <path>");
            return json(await readSkillFile(parsed.positionals[0]!, parsed.positionals[1]!, options));
        case "get":
            expectPositionals(parsed.positionals, 2, "skill get <name> <instance:/workspace>");
            return json(await getSkill(
                extension,
                parsed.positionals[0]!,
                parsed.positionals[1]!,
                options,
                invocation
            ));
        default:
            throw usageError(`Unknown skill command: ${command}`);
    }
}

async function getSkill(
    extension: ExtensionContext,
    name: string,
    targetText: string,
    options: SkillCatalogOptions,
    invocation: ExtensionInvocationContext
): Promise<ExtensionJsonValue> {
    const requested = parseTarget(targetText);
    const selected = await resolveSkillSource(name, options);
    const asset = await extension.assets.installDirectory(selected.root);
    const session = await extension.worker.openSession(requested);
    try {
        await prepareManagedSkillDirectory(session, invocation);
        const transfer = await extension.assets.transferBundle({
            generation: asset.generation,
            overwrite: true,
            signal: invocation.signal,
            target: {
                instance: session.instance,
                path: `./${MANAGED_SKILL_RELATIVE_DIRECTORY}/${name}`,
                workspace: session.environment.homeDirectory
            }
        });
        return transferResult(name, selected.source, asset.generation, session, transfer);
    } finally {
        await session.close();
    }
}

async function prepareManagedSkillDirectory(
    session: ExtensionWorkerSession,
    invocation: ExtensionInvocationContext
): Promise<void> {
    if (!session.listTools().some((tool) => tool.name === "bash_run")) {
        throw new Error(`Worker ${session.instance} does not provide bash_run.`);
    }
    const windows = session.environment.platform.os === "windows";
    const command = windows
        ? "New-Item -ItemType Directory -Force -LiteralPath (Join-Path $HOME '.devshell/skill') | Out-Null"
        : 'mkdir -p -- "$HOME/.devshell/skill"';
    const result = await session.callTool("bash_run", {
        command,
        cwd: "./",
        timeoutMs: 10_000
    }, {
        operationId: "skill.get.prepare",
        signal: invocation.signal
    });
    if (!isRecord(result) || result.exitCode !== 0) {
        const stderr = isRecord(result) && typeof result.stderr === "string" ? result.stderr.trim() : "";
        throw new Error(
            stderr.length > 0
                ? `Could not prepare the managed Skill directory: ${stderr}`
                : "Could not prepare the managed Skill directory."
        );
    }
}

function transferResult(
    name: string,
    source: string,
    generation: string,
    session: ExtensionWorkerSession,
    transfer: ExtensionAssetTransferResult
): ExtensionJsonValue {
    return {
        generation,
        name,
        source,
        target: {
            instance: session.instance,
            path: `./${MANAGED_SKILL_RELATIVE_DIRECTORY}/${name}`,
            workspace: session.environment.homeDirectory
        },
        transfer: {
            transferId: transfer.transferId,
            transferredBytes: transfer.transferredBytes
        }
    };
}

function catalogOptions(
    requestedWorkspace: string | undefined,
    invocation: ExtensionInvocationContext
): SkillCatalogOptions {
    const caller = invocation.workingDirectory;
    if (requestedWorkspace === undefined) {
        if (caller === undefined) {
            throw usageError("skill requires the local CLI working directory or --workspace <directory>");
        }
        return { workspace: caller };
    }
    if (isAbsolute(requestedWorkspace)) return { workspace: requestedWorkspace };
    if (caller === undefined) {
        throw usageError("relative --workspace requires the local CLI working directory");
    }
    return { workspace: resolve(caller, requestedWorkspace) };
}

function parseArgs(args: readonly string[]): { positionals: string[]; workspace?: string } {
    const positionals: string[] = [];
    let workspace: string | undefined;
    for (let index = 0; index < args.length; index += 1) {
        const value = args[index]!;
        if (value === "--workspace") {
            if (workspace !== undefined) throw usageError("skill --workspace may be supplied only once");
            const candidate = args[++index];
            if (candidate === undefined || candidate.length === 0) {
                throw usageError("skill --workspace requires a directory");
            }
            workspace = candidate;
            continue;
        }
        if (value.startsWith("-")) throw usageError(`Unknown skill option: ${value}`);
        positionals.push(value);
    }
    return { positionals, ...(workspace === undefined ? {} : { workspace }) };
}

function parseTarget(value: string): { instance: string; workspace: string } {
    const separator = value.indexOf(":");
    if (separator <= 0 || separator === value.length - 1) {
        throw usageError("Skill target must use <instance:/absolute/workspace>.");
    }
    const instance = value.slice(0, separator);
    const workspace = value.slice(separator + 1);
    if (!/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+$/u.test(instance)) {
        throw usageError("Skill target instance name is invalid.");
    }
    if (!isTargetAbsolute(workspace)) {
        throw usageError("Skill target workspace must be absolute.");
    }
    return { instance, workspace };
}

function isTargetAbsolute(value: string): boolean {
    return value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("\\\\");
}

function expectPositionals(values: readonly string[], expected: number, usage: string): void {
    if (values.length !== expected) throw usageError(`Usage: devshell ${usage}`);
}

function requireLocalOwner(invocation: ExtensionInvocationContext): void {
    if (!invocation.localOwner) {
        throw new Error("Skill commands are restricted to the local owner CLI.");
    }
}

function json(value: unknown): ExtensionCommandResult {
    return { kind: "json", value: value as ExtensionJsonValue };
}

function usageError(message: string): TypeError {
    return new TypeError(`${message}\n\n${SKILL_USAGE}`);
}

function isRecord(value: ExtensionJsonValue): value is Record<string, ExtensionJsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
