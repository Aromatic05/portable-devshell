import { globSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";

export function discoverSshConfigHosts(
    entryPath = resolve(homedir(), ".ssh", "config"),
): readonly string[] {
    const hosts = new Set<string>();
    const visited = new Set<string>();
    readConfig(entryPath, hosts, visited);
    return [...hosts].sort((left, right) => left.localeCompare(right));
}

function readConfig(
    path: string,
    hosts: Set<string>,
    visited: Set<string>,
): void {
    const normalized = resolve(path);
    if (visited.has(normalized)) return;
    visited.add(normalized);

    let source: string;
    try {
        source = readFileSync(normalized, "utf8");
    } catch {
        return;
    }

    for (const rawLine of source.split(/\r?\n/u)) {
        const line = stripComment(rawLine).trim();
        if (line.length === 0) continue;
        const match = /^(\S+)\s+(.+)$/u.exec(line);
        if (match === null) continue;
        const keyword = match[1]!.toLowerCase();
        const value = match[2]!.trim();
        if (keyword === "host") {
            for (const host of splitWords(value)) {
                if (
                    host.length > 0 &&
                    !host.startsWith("!") &&
                    !host.includes("*") &&
                    !host.includes("?")
                ) {
                    hosts.add(host);
                }
            }
            continue;
        }
        if (keyword !== "include") continue;
        for (const include of splitWords(value)) {
            const expanded = include.startsWith("~/")
                ? resolve(homedir(), include.slice(2))
                : isAbsolute(include)
                  ? include
                  : resolve(dirname(normalized), include);
            let includedPaths: string[];
            try {
                includedPaths = globSync(expanded);
            } catch {
                continue;
            }
            for (const includedPath of includedPaths) {
                readConfig(includedPath, hosts, visited);
            }
        }
    }
}

function stripComment(line: string): string {
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
        const char = line[index];
        if (char === '"') quoted = !quoted;
        if (char === "#" && !quoted) return line.slice(0, index);
    }
    return line;
}

function splitWords(value: string): string[] {
    return value
        .split(/\s+/u)
        .map((entry) => entry.replace(/^"|"$/gu, ""))
        .filter((entry) => entry.length > 0);
}
