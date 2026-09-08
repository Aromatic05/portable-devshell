import { matchesGlob, relative } from "node:path";

export interface SecretIgnoreScope {
    directory: string;
    rules: readonly SecretIgnoreRule[];
}

interface SecretIgnoreRule {
    directoryOnly: boolean;
    glob: string;
    negated: boolean;
}

export function parseSecretIgnore(source: string): readonly SecretIgnoreRule[] {
    const rules: SecretIgnoreRule[] = [];
    for (const rawLine of source.split(/\r?\n/u)) {
        const parsed = parseLine(rawLine);
        if (parsed !== undefined) rules.push(parsed);
    }
    return rules;
}

export function ignoredBySecretScopes(
    path: string,
    directory: boolean,
    scopes: readonly SecretIgnoreScope[]
): boolean {
    let ignored = false;
    for (const scope of scopes) {
        const candidate = normalizePath(relative(scope.directory, path));
        if (candidate === ".." || candidate.startsWith("../")) continue;
        for (const rule of scope.rules) {
            if (rule.directoryOnly && !directory) continue;
            if (matchesGlob(candidate, rule.glob)) ignored = !rule.negated;
        }
    }
    return ignored;
}

function parseLine(rawLine: string): SecretIgnoreRule | undefined {
    let line = trimUnescapedTrailingSpaces(rawLine);
    if (line.length === 0 || line.startsWith("#")) return undefined;
    if (line.startsWith("\\#")) line = line.slice(1);

    let negated = false;
    if (line.startsWith("!")) {
        negated = true;
        line = line.slice(1);
    } else if (line.startsWith("\\!")) {
        line = line.slice(1);
    }
    if (line.length === 0) return undefined;

    const directoryOnly = line.endsWith("/") && !line.endsWith("\\/");
    if (directoryOnly) line = line.slice(0, -1);
    const anchored = line.startsWith("/");
    if (anchored) line = line.slice(1);
    line = unescapePattern(line);
    if (line.length === 0) return undefined;

    const hasSlash = line.includes("/");
    const glob = anchored || hasSlash ? line : `**/${line}`;
    return { directoryOnly, glob, negated };
}

function trimUnescapedTrailingSpaces(value: string): string {
    let end = value.length;
    while (end > 0 && value.charCodeAt(end - 1) === 32) {
        let slashes = 0;
        for (let index = end - 2; index >= 0 && value.charCodeAt(index) === 92; index -= 1) slashes += 1;
        if (slashes % 2 === 1) break;
        end -= 1;
    }
    return value.slice(0, end);
}

function unescapePattern(value: string): string {
    return value.replace(/\\([#! ])/gu, "$1");
}

function normalizePath(path: string): string {
    return path.replaceAll("\\", "/");
}
