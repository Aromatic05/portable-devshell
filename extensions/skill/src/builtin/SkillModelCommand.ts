import type {
    ExtensionContext,
    ExtensionJsonValue,
    ExtensionWorkerSession
} from "@portable-devshell/extension";
import type {
    CliCommandResult,
    CliModelCommandInvocationContext
} from "@portable-devshell/extension/cli";

import {
    listSkills,
    loadSkill,
    readSkillFile,
    type LoadedSkill,
    type ReadSkillFileResult,
    type SkillMetadata
} from "./SkillCatalog.js";

export const SKILL_MODEL_USAGE = [
    "Usage:",
    "  devshell skill list",
    "  devshell skill search <query>",
    "  devshell skill load <name>",
    "  devshell skill inspect <name>",
    "  devshell skill read <name> <path>",
    "",
    "Project Skills come from the current model Workspace; managed/global Skills come from the Control-host Skill catalog."
].join("\n");

export async function executeSkillModelCommand(
    extension: ExtensionContext,
    argv: readonly string[],
    invocation: CliModelCommandInvocationContext
): Promise<CliCommandResult> {
    invocation.signal.throwIfAborted();
    const workers = extension.capabilities.workers;
    if (workers === undefined) throw new Error("Skill Extension model commands require the workers capability.");
    if (argv.length === 0 || ["help", "--help", "-h"].includes(argv[0] ?? "")) {
        if (argv.length > 1) throw usageError("skill help does not accept extra arguments");
        return { kind: "text", text: SKILL_MODEL_USAGE };
    }

    const session = await workers.openSession({
        instance: invocation.instance,
        workspace: invocation.workspace
    });
    try {
        switch (argv[0]) {
            case "list":
                expect(argv, 1, "skill list");
                return json(await modelList(session, invocation.signal));
            case "search":
                expect(argv, 2, "skill search <query>");
                return json(await modelSearch(session, argv[1]!, invocation.signal));
            case "load":
            case "inspect":
                expect(argv, 2, `skill ${argv[0]} <name>`);
                return json(await modelLoad(session, argv[1]!, invocation.signal));
            case "read":
                expect(argv, 3, "skill read <name> <path>");
                return json(await modelRead(session, argv[1]!, argv[2]!, invocation.signal));
            default:
                throw usageError(`Unknown skill command: ${argv[0]}`);
        }
    } finally {
        await session.close();
    }
}

async function modelList(session: ExtensionWorkerSession, signal: AbortSignal): Promise<{
    skills: SkillMetadata[];
    warnings: string[];
}> {
    const project = await projectSkills(session, signal);
    const local = await listSkills({ project: false });
    const accepted = new Set(project.map((skill) => skill.name));
    return {
        skills: [...project, ...local.skills.filter((skill) => !accepted.has(skill.name))]
            .sort((left, right) => left.name.localeCompare(right.name)),
        warnings: [...local.warnings]
    };
}

async function modelSearch(session: ExtensionWorkerSession, query: string, signal: AbortSignal) {
    const normalized = query.trim().toLowerCase();
    if (normalized.length === 0) throw usageError("skill search requires a non-empty query");
    const result = await modelList(session, signal);
    return {
        ...result,
        skills: result.skills.filter((skill) =>
            skill.name.toLowerCase().includes(normalized) || skill.description.toLowerCase().includes(normalized)
        )
    };
}

async function modelLoad(session: ExtensionWorkerSession, name: string, signal: AbortSignal): Promise<ExtensionJsonValue> {
    validateSkillName(name);
    const project = await projectSkill(session, name, signal);
    if (project !== undefined) return project as unknown as ExtensionJsonValue;
    const loaded = await loadSkill(name, { project: false });
    return sanitizeLoaded(loaded) as unknown as ExtensionJsonValue;
}

async function modelRead(
    session: ExtensionWorkerSession,
    name: string,
    path: string,
    signal: AbortSignal
): Promise<ExtensionJsonValue> {
    validateSkillName(name);
    const relativePath = validateRelatedPath(path);
    const project = await projectSkill(session, name, signal);
    if (project !== undefined) {
        if (relativePath === "SKILL.md") throw new Error("Use skill load to read SKILL.md");
        const content = await workerRead(session, `./.agents/skills/${name}/${relativePath}`, signal);
        return {
            bytes: Buffer.byteLength(content, "utf8"),
            content,
            name,
            path: relativePath,
            source: "project"
        };
    }
    return sanitizeRead(await readSkillFile(name, relativePath, { project: false })) as unknown as ExtensionJsonValue;
}

async function projectSkills(session: ExtensionWorkerSession, signal: AbortSignal): Promise<SkillMetadata[]> {
    const found = asRecord(await session.callTool("file_find", {
        paths: ["./.agents/skills/*/SKILL.md"],
        type: "file"
    }, { signal }));
    const entries = Array.isArray(found.entries) ? found.entries : [];
    const paths = entries.flatMap((entry) => {
        const value = asRecord(entry);
        return typeof value.path === "string" && /^\.\/\.agents\/skills\/[^/]+\/SKILL\.md$/u.test(value.path)
            ? [value.path]
            : [];
    }).slice(0, 256);
    if (paths.length === 0) return [];
    const read = asRecord(await session.callTool("file_read", {
        files: paths.map((path) => ({ path }))
    }, { signal }));
    const files = Array.isArray(read.files) ? read.files : [];
    return files.flatMap((entry) => {
        const value = asRecord(entry);
        if (typeof value.path !== "string" || typeof value.content !== "string") return [];
        const match = /^\.\/\.agents\/skills\/([^/]+)\/SKILL\.md$/u.exec(value.path);
        if (match === null) return [];
        return [{
            description: skillDescription(stripLineNumbers(value.content)),
            name: match[1]!,
            source: "project" as const
        }];
    });
}

async function projectSkill(
    session: ExtensionWorkerSession,
    name: string,
    signal: AbortSignal
): Promise<Omit<LoadedSkill, "sourcePath"> | undefined> {
    const root = `./.agents/skills/${name}`;
    let content: string;
    try {
        content = await workerRead(session, `${root}/SKILL.md`, signal);
    } catch (error) {
        if (isFileNotFound(error)) return undefined;
        throw error;
    }
    const found = asRecord(await session.callTool("file_find", {
        paths: [`${root}/**/*`],
        type: "file"
    }, { signal }));
    const entries = Array.isArray(found.entries) ? found.entries : [];
    const prefix = `${root}/`;
    const relatedFiles = entries.flatMap((entry) => {
        const value = asRecord(entry);
        if (typeof value.path !== "string" || !value.path.startsWith(prefix)) return [];
        const path = value.path.slice(prefix.length);
        return path === "SKILL.md" ? [] : [path];
    }).sort();
    return {
        bytes: Buffer.byteLength(content, "utf8"),
        content,
        description: skillDescription(content),
        name,
        relatedFiles,
        source: "project"
    };
}

async function workerRead(session: ExtensionWorkerSession, path: string, signal: AbortSignal): Promise<string> {
    const result = asRecord(await session.callTool("file_read", { path }, { signal }));
    if (typeof result.content !== "string") throw new Error(`Worker file_read returned no content for ${path}.`);
    return stripLineNumbers(result.content);
}

function sanitizeLoaded(value: LoadedSkill): Omit<LoadedSkill, "sourcePath"> {
    const { sourcePath: _sourcePath, ...safe } = value;
    return safe;
}

function sanitizeRead(value: ReadSkillFileResult): Omit<ReadSkillFileResult, "sourcePath"> {
    const { sourcePath: _sourcePath, ...safe } = value;
    return safe;
}

function stripLineNumbers(content: string): string {
    return content.split("\n").map((line) => line.replace(/^\d+:/u, "")).join("\n");
}

function skillDescription(markdown: string): string {
    const frontmatter = /^---\n[\s\S]*?^description\s*:\s*(.+)$[\s\S]*?^---$/imu.exec(markdown)?.[1]?.trim();
    if (frontmatter !== undefined && frontmatter.length > 0) return frontmatter.replace(/^['"]|['"]$/gu, "");
    const content = markdown.split("\n").map((line) => line.trim()).find((line) => line.length > 0 && !line.startsWith("#"));
    return content ?? "Agent skill";
}

function validateSkillName(name: string): void {
    if (name.length === 0 || name !== name.trim() || name === "." || name === ".." || /[\\/]/u.test(name)) {
        throw usageError("Skill name must be one non-empty directory name");
    }
}

function validateRelatedPath(path: string): string {
    if (path.length === 0 || path.includes("\\") || path.startsWith("/")) {
        throw usageError("Skill file path must be a relative POSIX path");
    }
    const parts = path.split("/");
    if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
        throw usageError("Skill file path must stay inside the Skill directory");
    }
    return parts.join("/");
}

function asRecord(value: unknown): Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function isFileNotFound(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && error.code === "file.notFound";
}

function expect(argv: readonly string[], length: number, usageText: string): void {
    if (argv.length !== length) throw usageError(`Usage: devshell ${usageText}`);
}

function json(value: unknown): CliCommandResult {
    return { kind: "json", value: value as ExtensionJsonValue };
}

function usageError(message: string): TypeError {
    return new TypeError(`${message}\n\n${SKILL_MODEL_USAGE}`);
}
