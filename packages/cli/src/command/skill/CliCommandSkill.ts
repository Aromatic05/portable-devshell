import { homedir } from "node:os";
import { lstat, open, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { CliRenderError } from "../../render/CliRenderError.js";

const MAX_SKILLS = 256;
const MAX_ENTRY_BYTES = 512 * 1024;
const MAX_LIST_PREVIEW_BYTES = 64 * 1024;
const MAX_RELATED_FILES = 1_000;
const MAX_RELATED_SCAN_ENTRIES = 5_000;

type SkillSourceName = "project" | "managed" | "global";

interface SkillSource {
    path: string;
    source: SkillSourceName;
}

export interface SkillCatalogOptions {
    configHome?: string;
    home?: string;
    workspace?: string;
}

export interface SkillMetadata {
    description: string;
    name: string;
    source: SkillSourceName;
}

export interface SkillListResult {
    skills: SkillMetadata[];
    sources: SkillSource[];
    warnings: string[];
}

export interface LoadedSkill extends SkillMetadata {
    bytes: number;
    content: string;
    relatedFiles: string[];
    sourcePath: string;
}

export interface ReadSkillFileResult {
    bytes: number;
    content: string;
    name: string;
    path: string;
    source: SkillSourceName;
    sourcePath: string;
}

export async function executeSkillCommand(
    args: readonly string[],
    output: { write(chunk: string): void },
    defaults: SkillCatalogOptions = {}
): Promise<void> {
    if (args.length === 0 || ["help", "--help", "-h"].includes(args[0] ?? "")) {
        output.write(`${renderSkillUsage()}\n`);
        return;
    }

    const command = args[0]!;
    const parsed = parseSkillArgs(args.slice(1), defaults);
    switch (command) {
        case "list":
            requirePositionals(parsed.positionals, 0, "skill list");
            writeJson(output, await listSkills(parsed.options));
            return;
        case "search":
            requirePositionals(parsed.positionals, 1, "skill search <query>");
            writeJson(output, await searchSkills(parsed.positionals[0]!, parsed.options));
            return;
        case "load":
        case "inspect":
            requirePositionals(parsed.positionals, 1, `skill ${command} <name>`);
            writeJson(output, await loadSkill(parsed.positionals[0]!, parsed.options));
            return;
        case "read":
            requirePositionals(parsed.positionals, 2, "skill read <name> <path>");
            writeJson(output, await readSkillFile(parsed.positionals[0]!, parsed.positionals[1]!, parsed.options));
            return;
        default:
            throw CliRenderError.usage(`Unknown skill command: ${command}\n\n${renderSkillUsage()}`);
    }
}

export async function listSkills(options: SkillCatalogOptions = {}): Promise<SkillListResult> {
    const sources = skillSources(options);
    const accepted = new Set<string>();
    const skills: SkillMetadata[] = [];
    const warnings: string[] = [];

    for (const source of sources) {
        for (const name of await skillDirectoryNames(source.path, warnings, source.source)) {
            if (accepted.has(name)) {
                warnings.push(`${source.source}: skipped duplicate Skill '${name}'; a higher-priority source already provides it`);
                continue;
            }
            if (skills.length >= MAX_SKILLS) {
                warnings.push(`Skill list truncated at ${MAX_SKILLS} entries`);
                return { skills: sortedSkills(skills), sources, warnings };
            }
            const entryPath = join(source.path, name, "SKILL.md");
            const preview = await readText(entryPath, MAX_LIST_PREVIEW_BYTES, true).catch((error) => {
                warnings.push(`${source.source}: skipping Skill '${name}': ${errorMessage(error)}`);
                return undefined;
            });
            if (preview === undefined) continue;
            skills.push({ description: skillDescription(preview.content), name, source: source.source });
            accepted.add(name);
        }
    }
    return { skills: sortedSkills(skills), sources, warnings };
}

export async function searchSkills(
    query: string,
    options: SkillCatalogOptions = {}
): Promise<SkillListResult> {
    const normalized = query.trim().toLowerCase();
    if (normalized.length === 0) throw CliRenderError.usage("skill search requires a non-empty query");
    const result = await listSkills(options);
    return {
        ...result,
        skills: result.skills.filter((skill) =>
            skill.name.toLowerCase().includes(normalized) || skill.description.toLowerCase().includes(normalized)
        )
    };
}

export async function loadSkill(name: string, options: SkillCatalogOptions = {}): Promise<LoadedSkill> {
    validateSkillName(name);
    const errors: string[] = [];
    for (const source of skillSources(options)) {
        const root = join(source.path, name);
        if (!await isDirectory(root)) continue;
        try {
            const entry = await readText(join(root, "SKILL.md"), MAX_ENTRY_BYTES, false);
            return {
                bytes: entry.bytes,
                content: entry.content,
                description: skillDescription(entry.content),
                name,
                relatedFiles: await relatedFiles(root),
                source: source.source,
                sourcePath: source.path
            };
        } catch (error) {
            errors.push(`${source.source}: ${errorMessage(error)}`);
        }
    }
    if (errors.length > 0) throw new Error(`Could not load Skill '${name}': ${errors.join("; ")}`);
    throw new Error(`Unknown Skill '${name}'. Run devshell skill list to discover installed Skills.`);
}

export async function readSkillFile(
    name: string,
    path: string,
    options: SkillCatalogOptions = {}
): Promise<ReadSkillFileResult> {
    validateSkillName(name);
    const relativePath = validateRelatedPath(path);
    if (relativePath === "SKILL.md") throw new Error("Use skill load to read SKILL.md");
    const selected = await selectSkillSource(name, options);
    const file = await readText(join(selected.root, ...relativePath.split("/")), MAX_ENTRY_BYTES, false);
    return {
        bytes: file.bytes,
        content: file.content,
        name,
        path: relativePath,
        source: selected.source.source,
        sourcePath: selected.source.path
    };
}

export function renderSkillUsage(): string {
    return [
        "Usage:",
        "  devshell skill list [--workspace <directory>]",
        "  devshell skill search <query> [--workspace <directory>]",
        "  devshell skill load <name> [--workspace <directory>]",
        "  devshell skill inspect <name> [--workspace <directory>]",
        "  devshell skill read <name> <path> [--workspace <directory>]",
        "",
        "Lookup priority: project .agents/skills, managed ~/.devshell/skill, global $XDG_CONFIG_HOME/agents/skills.",
        "List/search return metadata only; load/read perform lazy content access."
    ].join("\n");
}

function skillSources(options: SkillCatalogOptions): SkillSource[] {
    const home = resolve(options.home ?? homedir());
    const workspace = resolve(options.workspace ?? process.cwd());
    const configHome = resolve(options.configHome ?? process.env.XDG_CONFIG_HOME ?? join(home, ".config"));
    const candidates: SkillSource[] = [
        { path: join(workspace, ".agents", "skills"), source: "project" },
        { path: join(home, ".devshell", "skill"), source: "managed" },
        { path: join(configHome, "agents", "skills"), source: "global" }
    ];
    const seen = new Set<string>();
    return candidates.filter((source) => {
        const key = resolve(source.path);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

async function selectSkillSource(
    name: string,
    options: SkillCatalogOptions
): Promise<{ root: string; source: SkillSource }> {
    const errors: string[] = [];
    for (const source of skillSources(options)) {
        const root = join(source.path, name);
        if (!await isDirectory(root)) continue;
        try {
            await readText(join(root, "SKILL.md"), MAX_ENTRY_BYTES, false);
            return { root, source };
        } catch (error) {
            errors.push(`${source.source}: ${errorMessage(error)}`);
        }
    }
    if (errors.length > 0) throw new Error(`Could not load Skill '${name}': ${errors.join("; ")}`);
    throw new Error(`Unknown Skill '${name}'. Run devshell skill list to discover installed Skills.`);
}

async function skillDirectoryNames(path: string, warnings: string[], source: SkillSourceName): Promise<string[]> {
    let entries;
    try {
        entries = await readdir(path, { withFileTypes: true });
    } catch (error) {
        if (isEnoent(error)) return [];
        warnings.push(`${source}: could not scan ${path}: ${errorMessage(error)}`);
        return [];
    }
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

async function relatedFiles(root: string): Promise<string[]> {
    const files: string[] = [];
    let scanned = 0;
    async function walk(directory: string): Promise<void> {
        if (files.length >= MAX_RELATED_FILES || scanned >= MAX_RELATED_SCAN_ENTRIES) return;
        const entries = await readdir(directory, { withFileTypes: true });
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            if (files.length >= MAX_RELATED_FILES || scanned >= MAX_RELATED_SCAN_ENTRIES) return;
            scanned += 1;
            if (entry.name === ".git") continue;
            const path = join(directory, entry.name);
            if (entry.isDirectory()) {
                await walk(path);
                continue;
            }
            if (!entry.isFile()) continue;
            const displayed = normalizePath(relative(root, path));
            if (displayed !== "SKILL.md") files.push(displayed);
        }
    }
    await walk(root);
    return files.sort();
}

async function readText(
    path: string,
    maxBytes: number,
    allowTruncate: boolean
): Promise<{ bytes: number; content: string }> {
    let handle;
    try {
        handle = await open(path, "r");
        const info = await handle.stat();
        if (!info.isFile()) throw new Error("Skill entry must be a regular file");
        if (!allowTruncate && info.size > maxBytes) {
            throw new Error(`Skill file is ${info.size} bytes; maximum is ${maxBytes}`);
        }
        const length = Math.min(info.size, maxBytes);
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, 0);
        return {
            bytes: allowTruncate ? info.size : bytesRead,
            content: buffer.subarray(0, bytesRead).toString("utf8").replaceAll("\r\n", "\n").replaceAll("\r", "\n")
        };
    } finally {
        await handle?.close().catch(() => undefined);
    }
}

async function isDirectory(path: string): Promise<boolean> {
    try {
        return (await lstat(path)).isDirectory();
    } catch (error) {
        if (isEnoent(error)) return false;
        throw error;
    }
}

function skillDescription(markdown: string): string {
    const lines = markdown.split("\n");
    let index = 0;
    while (index < lines.length && lines[index]!.trim().length === 0) index += 1;
    if (lines[index]?.trim() === "---") {
        for (index += 1; index < lines.length && lines[index]!.trim() !== "---"; index += 1) {
            const match = /^description\s*:\s*(.+)$/iu.exec(lines[index]!.trim());
            if (match !== null) return normalizeDescription(stripQuotes(match[1]!));
        }
        index += 1;
    }

    let heading: string | undefined;
    let fenced = false;
    for (; index < lines.length; index += 1) {
        const line = lines[index]!.trim();
        if (line.startsWith("```") || line.startsWith("~~~")) {
            fenced = !fenced;
            continue;
        }
        if (fenced || line.length === 0) continue;
        if (line.startsWith("#")) {
            heading ??= line.replace(/^#+\s*/u, "").trim();
            continue;
        }
        return normalizeDescription(firstSentence(line));
    }
    return normalizeDescription(heading ?? "Agent skill");
}

function firstSentence(value: string): string {
    return /^(.+?[.!?])(?:\s|$)/u.exec(value)?.[1] ?? value;
}

function normalizeDescription(value: string): string {
    const normalized = value.replace(/\s+/gu, " ").trim();
    return normalized.length <= 500 ? normalized : `${normalized.slice(0, 499).trimEnd()}…`;
}

function stripQuotes(value: string): string {
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
        return value.slice(1, -1);
    }
    return value;
}

function validateSkillName(name: string): void {
    if (name.length === 0 || name !== name.trim() || name === "." || name === ".." || /[\\/]/u.test(name)) {
        throw CliRenderError.usage("Skill name must be one non-empty directory name");
    }
}

function validateRelatedPath(path: string): string {
    if (path.length === 0 || path.includes("\\") || isAbsolute(path)) {
        throw CliRenderError.usage("Skill file path must be a relative POSIX path");
    }
    const parts = path.split("/");
    if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
        throw CliRenderError.usage("Skill file path must stay inside the Skill directory");
    }
    return parts.join("/");
}

function parseSkillArgs(
    args: readonly string[],
    defaults: SkillCatalogOptions
): { options: SkillCatalogOptions; positionals: string[] } {
    const positionals: string[] = [];
    let workspace = defaults.workspace;
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index]!;
        if (argument === "--workspace") {
            const value = args[++index];
            if (value === undefined || value.length === 0) throw CliRenderError.usage("skill --workspace requires a directory");
            workspace = value;
            continue;
        }
        if (argument.startsWith("-")) throw CliRenderError.usage(`Unknown skill option: ${argument}`);
        positionals.push(argument);
    }
    return {
        options: {
            ...defaults,
            ...(workspace === undefined ? {} : { workspace })
        },
        positionals
    };
}

function requirePositionals(values: readonly string[], expected: number, usage: string): void {
    if (values.length !== expected) throw CliRenderError.usage(`Usage: devshell ${usage}`);
}

function sortedSkills(skills: SkillMetadata[]): SkillMetadata[] {
    return [...skills].sort((a, b) => a.name.localeCompare(b.name));
}

function writeJson(output: { write(chunk: string): void }, value: unknown): void {
    output.write(`${JSON.stringify(value, null, 2)}\n`);
}

function normalizePath(path: string): string {
    return path.replaceAll("\\", "/");
}

function isEnoent(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
