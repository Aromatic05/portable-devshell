import {
    createSyntheticSourceInfo,
    parseFrontmatter,
    stripFrontmatter,
    type InputEvent,
    type InputEventResult,
    type PromptTemplate,
    type Skill
} from "@earendil-works/pi-coding-agent";
import type { JsonValue } from "@portable-devshell/shared";

import type { DevshellPiTarget } from "./DevshellPiTarget.js";

export interface DevshellPiContextFile {
    content: string;
    path: string;
}

export interface DevshellPiWorkspaceSkill {
    content: string;
    resource: Skill;
}

export interface DevshellPiWorkspaceResources {
    contextFiles: DevshellPiContextFile[];
    prompts: PromptTemplate[];
    skills: DevshellPiWorkspaceSkill[];
}

export function expandDevshellPiPromptTemplate(prompt: PromptTemplate, argsString: string): string {
    return substitutePromptArgs(prompt.content, parsePromptArgs(argsString));
}

type DevshellPiToolCall = (
    toolName: string,
    input: JsonValue,
    operationId: string
) => Promise<JsonValue>;

const PI_CONTEXT_FILE_NAMES = [
    "AGENTS.override.md",
    "AGENTS.md",
    "AGENTS.MD",
    "CLAUDE.md",
    "CLAUDE.MD"
] as const;

const PI_PROJECT_SKILLS = "./.pi/skills/";
const PI_PROJECT_PROMPTS = "./.pi/prompts/";
const PI_PROJECT_SKILLS_DIRECTORY = "./.pi/skills";
const PI_PROJECT_PROMPTS_DIRECTORY = "./.pi/prompts";

export async function loadDevshellPiWorkspaceResources(
    target: DevshellPiTarget,
    toolNames: ReadonlySet<string>,
    callTool: DevshellPiToolCall
): Promise<DevshellPiWorkspaceResources> {
    const contextFiles = await loadDevshellPiWorkspaceContext(target, toolNames, callTool);
    if (!toolNames.has("file_find") || !toolNames.has("file_read")) {
        return { contextFiles, prompts: [], skills: [] };
    }
    const resourcePaths = await projectResourcePaths(toolNames, callTool);
    if (resourcePaths.length === 0) return { contextFiles, prompts: [], skills: [] };
    const found = asRecord(await callTool("file_find", {
        gitignore: true,
        hidden: true,
        paths: resourcePaths,
        type: "file"
    }, "pi-resources-find"));
    const paths = Array.isArray(found?.entries)
        ? found.entries.flatMap((value) => {
              const entry = asRecord(value);
              return entry?.type === "file" && typeof entry.path === "string"
                  ? [normalizeResourcePath(entry.path)]
                  : [];
          })
        : [];
    const skillPaths = selectProjectSkillPaths(paths);
    const promptPaths = [...new Set(paths.filter(isProjectPromptPath))].sort();
    const skills: DevshellPiWorkspaceSkill[] = [];
    const prompts: PromptTemplate[] = [];
    let readIndex = 0;
    for (const path of skillPaths) {
        const content = await readCompleteTextFile(path, callTool, `pi-resource-read-${++readIndex}`);
        const skill = toProjectSkill(target, path, content);
        if (skill !== undefined) skills.push(skill);
    }
    for (const path of promptPaths) {
        const content = await readCompleteTextFile(path, callTool, `pi-resource-read-${++readIndex}`);
        const prompt = toProjectPrompt(target, path, content);
        if (prompt !== undefined) prompts.push(prompt);
    }
    return { contextFiles, prompts, skills };
}

async function projectResourcePaths(
    toolNames: ReadonlySet<string>,
    callTool: DevshellPiToolCall
): Promise<string[]> {
    const skillPaths = ["./.pi/skills/*.md", "./.pi/skills/**/SKILL.md"];
    const promptPaths = ["./.pi/prompts/*.md"];
    if (!toolNames.has("file_info")) return [...skillPaths, ...promptPaths];

    const info = asRecord(await callTool("file_info", {
        paths: [PI_PROJECT_SKILLS_DIRECTORY, PI_PROJECT_PROMPTS_DIRECTORY]
    }, "pi-resources-info"));
    const entries = Array.isArray(info?.entries) ? info.entries : [];
    const directories = new Set(entries.flatMap((value) => {
        const entry = asRecord(value);
        return typeof entry?.path === "string" && entry.type === "directory" ? [entry.path] : [];
    }));
    return [
        ...(directories.has(PI_PROJECT_SKILLS_DIRECTORY) ? skillPaths : []),
        ...(directories.has(PI_PROJECT_PROMPTS_DIRECTORY) ? promptPaths : [])
    ];
}

export function transformDevshellPiSkillInput(
    skills: readonly DevshellPiWorkspaceSkill[],
    event: InputEvent
): InputEventResult | undefined {
    if (!event.text.startsWith("/skill:")) return undefined;
    const spaceIndex = event.text.indexOf(" ");
    const skillName = spaceIndex === -1 ? event.text.slice(7) : event.text.slice(7, spaceIndex);
    const args = spaceIndex === -1 ? "" : event.text.slice(spaceIndex + 1).trim();
    const skill = skills.find((candidate) => candidate.resource.name === skillName);
    if (skill === undefined) return undefined;
    const body = stripFrontmatter(skill.content).trim();
    const resource = skill.resource;
    const block = [
        `<skill name="${resource.name}" location="${resource.filePath}">`,
        `References are relative to ${resource.baseDir}.`,
        "",
        body,
        "</skill>"
    ].join("\n");
    return { action: "transform", text: args.length === 0 ? block : `${block}\n\n${args}` };
}

function parsePromptArgs(argsString: string): string[] {
    const args: string[] = [];
    let current = "";
    let quote: "\"" | "'" | undefined;
    for (const character of argsString) {
        if (quote !== undefined) {
            if (character === quote) quote = undefined;
            else current += character;
            continue;
        }
        if (character === "\"" || character === "'") {
            quote = character;
            continue;
        }
        if (/\s/u.test(character)) {
            if (current.length > 0) {
                args.push(current);
                current = "";
            }
            continue;
        }
        current += character;
    }
    if (current.length > 0) args.push(current);
    return args;
}

function substitutePromptArgs(content: string, args: readonly string[]): string {
    const allArgs = args.join(" ");
    return content.replace(
        /\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/gu,
        (_match, defaultTarget, defaultValue, sliceStart, sliceLength, simple) => {
            if (defaultTarget !== undefined) {
                const value = defaultTarget === "@" || defaultTarget === "ARGUMENTS"
                    ? allArgs
                    : args[Number.parseInt(defaultTarget, 10) - 1];
                return value ? value : defaultValue;
            }
            if (sliceStart !== undefined) {
                const start = Math.max(Number.parseInt(sliceStart, 10) - 1, 0);
                return sliceLength === undefined
                    ? args.slice(start).join(" ")
                    : args.slice(start, start + Number.parseInt(sliceLength, 10)).join(" ");
            }
            if (simple === "ARGUMENTS" || simple === "@") return allArgs;
            return args[Number.parseInt(simple, 10) - 1] ?? "";
        }
    );
}

export async function loadDevshellPiWorkspaceContext(
    target: DevshellPiTarget,
    toolNames: ReadonlySet<string>,
    callTool: DevshellPiToolCall
): Promise<DevshellPiContextFile[]> {
    if (!toolNames.has("file_find") || !toolNames.has("file_read")) return [];
    const found = asRecord(await callTool("file_find", {
        gitignore: false,
        hidden: true,
        paths: ["./AGENTS*", "./CLAUDE*"],
        type: "file"
    }, "pi-context-find"));
    const entries = Array.isArray(found?.entries) ? found.entries : [];
    const existing = new Map<string, string>();
    for (const value of entries) {
        const entry = asRecord(value);
        if (entry === undefined || typeof entry.path !== "string" || entry.type !== "file") continue;
        const name = contextFileName(entry.path);
        if (name !== undefined && !existing.has(name)) existing.set(name, entry.path);
    }
    const name = PI_CONTEXT_FILE_NAMES.find((candidate) => existing.has(candidate));
    if (name === undefined) return [];
    const path = existing.get(name)!;
    return [{
        content: await readCompleteTextFile(path, callTool),
        path: remoteContextPath(target, name)
    }];
}

async function readCompleteTextFile(
    path: string,
    callTool: DevshellPiToolCall,
    operationPrefix = "pi-context-read"
): Promise<string> {
    const lines = new Map<number, string>();
    let selector: string | undefined;
    let page = 0;
    do {
        const result = asRecord(await callTool(
            "file_read",
            { path, view: "content", ...(selector === undefined ? {} : { selector }) },
            `${operationPrefix}-${++page}`
        ));
        const content = typeof result?.content === "string" ? result.content : "";
        for (const line of content.split("\n")) {
            if (line.length === 0) continue;
            const match = /^(\d+):(.*)$/u.exec(line);
            if (match === null) throw new Error(`file_read returned malformed context content for ${path}.`);
            lines.set(Number(match[1]), match[2] ?? "");
        }
        const next = typeof result?.nextSelector === "string" ? result.nextSelector : undefined;
        selector = next !== undefined && /^\d+$/u.test(next) ? `${next}:raw` : next;
    } while (selector !== undefined);
    return [...lines.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, line]) => line)
        .join("\n")
        .replace(/^\uFEFF/u, "");
}

function normalizeResourcePath(path: string): string {
    const normalized = path.replaceAll("\\", "/");
    return normalized.startsWith("./") ? normalized : `./${normalized.replace(/^\/+/, "")}`;
}

function selectProjectSkillPaths(paths: readonly string[]): string[] {
    const candidates = [...new Set(paths.filter((path) => {
        if (!path.startsWith(PI_PROJECT_SKILLS) || !path.endsWith(".md")) return false;
        const relative = path.slice(PI_PROJECT_SKILLS.length);
        const parts = relative.split("/");
        if (parts.some((part, index) => index < parts.length - 1 && (part.startsWith(".") || part === "node_modules"))) {
            return false;
        }
        return parts.length === 1 || parts.at(-1) === "SKILL.md";
    }))];
    const rootSkill = `${PI_PROJECT_SKILLS}SKILL.md`;
    if (candidates.includes(rootSkill)) return [rootSkill];

    const direct = candidates.filter((path) => !path.slice(PI_PROJECT_SKILLS.length).includes("/"));
    const nested = candidates
        .filter((path) => path.slice(PI_PROJECT_SKILLS.length).includes("/") && path.endsWith("/SKILL.md"))
        .sort((left, right) => pathDepth(left) - pathDepth(right) || left.localeCompare(right));
    const selected = [...direct.sort()];
    const roots: string[] = [];
    for (const path of nested) {
        const directory = path.slice(0, -"/SKILL.md".length);
        if (roots.some((root) => directory.startsWith(`${root}/`))) continue;
        roots.push(directory);
        selected.push(path);
    }
    return selected;
}

function isProjectPromptPath(path: string): boolean {
    if (!path.startsWith(PI_PROJECT_PROMPTS) || !path.endsWith(".md")) return false;
    return !path.slice(PI_PROJECT_PROMPTS.length).includes("/");
}

function pathDepth(path: string): number {
    return path.split("/").length;
}

function toProjectSkill(
    target: DevshellPiTarget,
    path: string,
    content: string
): DevshellPiWorkspaceSkill | undefined {
    try {
        const { frontmatter } = parseFrontmatter<Record<string, unknown>>(content);
        const description = typeof frontmatter.description === "string" ? frontmatter.description : "";
        if (description.trim().length === 0) return undefined;
        const remoteFilePath = remoteProjectPath(target, path);
        const baseDir = remoteDirname(remoteFilePath);
        const name = typeof frontmatter.name === "string" && frontmatter.name.length > 0
            ? frontmatter.name
            : remoteBasename(baseDir);
        const resource: Skill = {
            baseDir,
            description,
            disableModelInvocation: frontmatter["disable-model-invocation"] === true,
            filePath: remoteFilePath,
            name,
            sourceInfo: createSyntheticSourceInfo(remoteFilePath, {
                baseDir,
                scope: "project",
                source: "local"
            })
        };
        return { content, resource };
    } catch {
        return undefined;
    }
}

function toProjectPrompt(
    target: DevshellPiTarget,
    path: string,
    content: string
): PromptTemplate | undefined {
    try {
        const { body, frontmatter } = parseFrontmatter<Record<string, unknown>>(content);
        const remoteFilePath = remoteProjectPath(target, path);
        const baseDir = remoteDirname(remoteFilePath);
        const firstLine = body.split("\n").find((line) => line.trim().length > 0);
        const frontmatterDescription = typeof frontmatter.description === "string" ? frontmatter.description : "";
        const description = frontmatterDescription.length > 0
            ? frontmatterDescription
            : firstLine === undefined
                ? ""
                : firstLine.length > 60
                    ? `${firstLine.slice(0, 60)}...`
                    : firstLine;
        const argumentHint = typeof frontmatter["argument-hint"] === "string"
            ? frontmatter["argument-hint"]
            : undefined;
        return {
            ...(argumentHint === undefined ? {} : { argumentHint }),
            content: body,
            description,
            filePath: remoteFilePath,
            name: resourceBasename(path).replace(/\.md$/u, ""),
            sourceInfo: createSyntheticSourceInfo(remoteFilePath, {
                baseDir,
                scope: "project",
                source: "local"
            })
        };
    } catch {
        return undefined;
    }
}

function resourceBasename(path: string): string {
    const normalized = path.replaceAll("\\", "/");
    return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function remoteProjectPath(target: DevshellPiTarget, path: string): string {
    const separator = remoteSeparator(target.workspace);
    const relative = normalizeResourcePath(path).slice(2).replaceAll("/", separator);
    const workspace = target.workspace.replace(/[\\/]+$/u, "");
    return workspace.length === 0 ? `${separator}${relative}` : `${workspace}${separator}${relative}`;
}

function remoteSeparator(workspace: string): "\\" | "/" {
    return workspace.includes("\\") && !workspace.includes("/") ? "\\" : "/";
}

function remoteDirname(path: string): string {
    const separator = remoteSeparator(path);
    const index = path.lastIndexOf(separator);
    return index <= 0 ? path.slice(0, Math.max(index, 1)) : path.slice(0, index);
}

function remoteBasename(path: string): string {
    const separator = remoteSeparator(path);
    return path.slice(path.lastIndexOf(separator) + 1);
}

function contextFileName(path: string): typeof PI_CONTEXT_FILE_NAMES[number] | undefined {
    const normalized = path.replaceAll("\\", "/");
    const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
    return PI_CONTEXT_FILE_NAMES.find((candidate) => candidate === basename);
}

function remoteContextPath(target: DevshellPiTarget, name: string): string {
    const separator = remoteSeparator(target.workspace);
    const workspace = target.workspace.replace(/[\\/]+$/u, "");
    return `${target.instance}:${workspace}${separator}${name}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}
