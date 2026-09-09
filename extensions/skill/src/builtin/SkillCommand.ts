import { isAbsolute, resolve } from "node:path";

import type {
    ExtensionAssetProjectionResult,
    ExtensionContext,
    ExtensionJsonValue
} from "@portable-devshell/extension";
import type {
    CliNativeCommandInvocationContext,
    CliCommandResult
} from "@portable-devshell/extension/cli";

import {
    listSkills,
    loadSkill,
    readSkillFile,
    resolveSkillSource,
    searchSkills,
    type SkillCatalogOptions
} from "./SkillCatalog.js";

const MANAGED_SKILL_COLLECTION = "managed";

export const SKILL_USAGE = [
    "Usage:",
    "  devshell skill list [--workspace <directory>]",
    "  devshell skill search <query> [--workspace <directory>]",
    "  devshell skill load <name> [--workspace <directory>]",
    "  devshell skill inspect <name> [--workspace <directory>]",
    "  devshell skill read <name> <path> [--workspace <directory>]",
    "  devshell skill get <name> <instance> [--workspace <local-directory>]",
    "",
    "Lookup priority: project .agents/skills, managed ~/.devshell/skill, global $XDG_CONFIG_HOME/agents/skills.",
    "get snapshots the selected local Skill and projects it into the target Worker's managed resource collection."
].join("\n");

export async function executeSkillCommand(
    extension: ExtensionContext,
    argv: readonly string[],
    invocation: CliNativeCommandInvocationContext
): Promise<CliCommandResult> {
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
            expectPositionals(parsed.positionals, 2, "skill get <name> <instance>");
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
    invocation: CliNativeCommandInvocationContext
): Promise<ExtensionJsonValue> {
    const instance = parseInstance(targetText);
    const selected = await resolveSkillSource(name, options);
    const assets = extension.capabilities.assets;
    if (assets === undefined) throw new Error("Skill Extension requires the assets capability.");
    const asset = await assets.installDirectory(selected.root);
    const projection = await assets.projectBundle({
        generation: asset.generation,
        overwrite: true,
        signal: invocation.signal,
        target: {
            collection: MANAGED_SKILL_COLLECTION,
            instance,
            key: name
        }
    });
    return projectionResult(name, selected.source, asset.generation, instance, projection);
}

function projectionResult(
    name: string,
    source: string,
    generation: string,
    instance: string,
    projection: ExtensionAssetProjectionResult
): ExtensionJsonValue {
    return {
        generation,
        name,
        source,
        target: {
            collection: MANAGED_SKILL_COLLECTION,
            instance,
            key: name
        },
        projection: {
            transferredBytes: projection.transferredBytes
        }
    };
}

function catalogOptions(
    requestedWorkspace: string | undefined,
    invocation: CliNativeCommandInvocationContext
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

function parseInstance(value: string): string {
    if (!/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+$/u.test(value)) {
        throw usageError("Skill target instance name is invalid.");
    }
    return value;
}

function expectPositionals(values: readonly string[], expected: number, usage: string): void {
    if (values.length !== expected) throw usageError(`Usage: devshell ${usage}`);
}

function requireLocalOwner(invocation: CliNativeCommandInvocationContext): void {
    if (!invocation.localOwner) {
        throw new Error("Skill commands are restricted to the local owner CLI.");
    }
}

function json(value: unknown): CliCommandResult {
    return { kind: "json", value: value as ExtensionJsonValue };
}

function usageError(message: string): TypeError {
    return new TypeError(`${message}\n\n${SKILL_USAGE}`);
}
