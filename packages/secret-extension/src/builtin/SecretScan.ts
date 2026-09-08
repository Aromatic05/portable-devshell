import { spawnSync } from "node:child_process";
import { open, readFile, readdir, stat } from "node:fs/promises";
import { matchesGlob, relative, resolve } from "node:path";

import {
    ignoredBySecretScopes,
    parseSecretIgnore,
    type SecretIgnoreScope
} from "./SecretIgnore.js";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1_000;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_DISCOVERED_FILES = 20_000;
const MAX_DISCOVERY_ENTRIES = 50_000;
const FALLBACK_SKIP_DIRECTORIES = new Set([".git", ".hg", ".svn", "node_modules"]);

interface DiscoveryResult {
    files: string[];
    truncated: boolean;
}

const SECRET_PATTERNS: ReadonlyArray<{ pattern: RegExp; type: string }> = [
    { pattern: /gh[pousr]_[A-Za-z0-9_]{36,}/gu, type: "github_token" },
    { pattern: /AKIA[0-9A-Z]{16}/gu, type: "aws_access_key" },
    { pattern: /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/gu, type: "private_key" },
    {
        pattern: /(token|secret|password|passwd|api_key|apikey)\s*[:=]\s*['"][^'"]{8,}['"]/giu,
        type: "generic_assignment"
    }
];

export interface SecretScanFinding {
    line: number;
    path: string;
    type: string;
}

export interface SecretScanResult {
    findings: SecretScanFinding[];
    truncated: boolean;
    truncatedFiles: number;
}

export interface SecretScanOptions {
    cwd: string;
    glob?: string;
    limit?: number;
}

export async function scanSecrets(options: SecretScanOptions): Promise<SecretScanResult> {
    const limit = normalizeLimit(options.limit);
    const base = resolve(options.cwd);
    const baseStat = await stat(base);
    if (!baseStat.isDirectory()) throw new TypeError(`secret scan path must be a directory: ${options.cwd}`);

    const discovery = discoverWithRipgrep(base) ?? await discoverFallback(base);
    const findings: SecretScanFinding[] = [];
    let truncatedFiles = 0;

    for (const candidate of discovery.files) {
        const displayPath = normalizePath(candidate);
        if (options.glob !== undefined && !matchesGlob(displayPath, options.glob)) continue;
        const read = await readCandidate(resolve(base, candidate));
        if (read === undefined) continue;
        if (read.truncated) truncatedFiles += 1;

        for (const { pattern, type } of SECRET_PATTERNS) {
            pattern.lastIndex = 0;
            for (const match of read.text.matchAll(pattern)) {
                if (type === "generic_assignment" && isPlaceholder(match[0])) continue;
                findings.push({ line: lineAt(read.text, match.index), path: displayPath, type });
                if (findings.length >= limit) {
                    return { findings, truncated: true, truncatedFiles };
                }
            }
        }
    }
    return { findings, truncated: discovery.truncated, truncatedFiles };
}

function normalizeLimit(limit: number | undefined): number {
    const value = limit ?? DEFAULT_LIMIT;
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError("secret scan limit must be a positive integer");
    return Math.min(value, MAX_LIMIT);
}

function discoverWithRipgrep(base: string): DiscoveryResult | undefined {
    const result = spawnSync("rg", ["--files", "--hidden", "--glob", "!.git/**"], {
        cwd: base,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true
    });
    if (result.error !== undefined || (result.status !== 0 && result.status !== 1)) return undefined;
    const files = result.stdout.split(/\r?\n/u).filter((value) => value.length > 0).sort();
    return {
        files: files.slice(0, MAX_DISCOVERED_FILES),
        truncated: files.length > MAX_DISCOVERED_FILES
    };
}

async function discoverFallback(base: string): Promise<DiscoveryResult> {
    const files: string[] = [];
    const state = { scanned: 0, truncated: false };
    await walk(base, base, files, [], state);
    files.sort();
    return { files, truncated: state.truncated };
}

async function walk(
    base: string,
    directory: string,
    files: string[],
    inheritedScopes: readonly SecretIgnoreScope[],
    state: { scanned: number; truncated: boolean }
): Promise<void> {
    if (state.truncated) return;
    const localScope = await readIgnoreScope(directory);
    const scopes = localScope === undefined ? inheritedScopes : [...inheritedScopes, localScope];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        state.scanned += 1;
        if (state.scanned > MAX_DISCOVERY_ENTRIES) {
            state.truncated = true;
            return;
        }
        const path = resolve(directory, entry.name);
        const displayPath = normalizePath(relative(base, path));
        if (entry.isDirectory()) {
            if (!FALLBACK_SKIP_DIRECTORIES.has(entry.name) && !ignoredBySecretScopes(path, true, scopes)) {
                await walk(base, path, files, scopes, state);
            }
            continue;
        }
        if (!entry.isFile() || ignoredBySecretScopes(path, false, scopes)) continue;
        files.push(displayPath);
        if (files.length >= MAX_DISCOVERED_FILES) {
            state.truncated = true;
            return;
        }
    }
}

async function readIgnoreScope(directory: string): Promise<SecretIgnoreScope | undefined> {
    const rules = [];
    for (const name of [".gitignore", ".ignore"]) {
        try {
            rules.push(...parseSecretIgnore(await readFile(resolve(directory, name), "utf8")));
        } catch (error) {
            if (!isEnoent(error)) throw error;
        }
    }
    return rules.length === 0 ? undefined : { directory, rules };
}

async function readCandidate(path: string): Promise<{ text: string; truncated: boolean } | undefined> {
    let handle;
    try {
        handle = await open(path, "r");
        const buffer = Buffer.allocUnsafe(MAX_FILE_BYTES + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const content = buffer.subarray(0, Math.min(bytesRead, MAX_FILE_BYTES));
        if (content.includes(0)) return undefined;
        return { text: content.toString("utf8"), truncated: bytesRead > MAX_FILE_BYTES };
    } catch {
        return undefined;
    } finally {
        await handle?.close().catch(() => undefined);
    }
}

function isPlaceholder(text: string): boolean {
    const lowered = text.toLowerCase();
    return ["${", "dev-", "dummy", "example", "fixture", "recent-token", "stale-token"].some(
        (marker) => lowered.includes(marker)
    );
}

function lineAt(text: string, offset: number): number {
    let line = 1;
    for (let index = 0; index < offset; index += 1) if (text.charCodeAt(index) === 10) line += 1;
    return line;
}

function normalizePath(path: string): string {
    return path.replaceAll("\\", "/");
}

function isEnoent(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
