import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import type { JsonValue } from "@portable-devshell/shared";

import type { DevshellPiToolSession } from "../adapt/Bridge.js";
import {
    parsePiAgentProfile,
    type PiAgentProfile,
} from "./Profile.js";

export class PiAgentProfileCatalog {
    readonly #agentDir: string;
    readonly #tools: DevshellPiToolSession;

    constructor(agentDir: string, tools: DevshellPiToolSession) {
        this.#agentDir = agentDir;
        this.#tools = tools;
    }

    async list(): Promise<PiAgentProfile[]> {
        const [user, project] = await Promise.all([
            loadLocalProfiles(join(this.#agentDir, "agents")),
            loadProjectProfiles(this.#tools),
        ]);
        const profiles = new Map<string, PiAgentProfile>();
        for (const profile of user) profiles.set(profile.name, profile);
        for (const profile of project) profiles.set(profile.name, profile);
        return [...profiles.values()].sort((left, right) =>
            left.name.localeCompare(right.name),
        );
    }

    async get(name: string): Promise<PiAgentProfile | undefined> {
        return (await this.list()).find((profile) => profile.name === name);
    }
}

async function loadLocalProfiles(directory: string): Promise<PiAgentProfile[]> {
    const entries = await readdir(directory, { withFileTypes: true }).catch(
        () => [],
    );
    const profiles: PiAgentProfile[] = [];
    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        const filePath = join(directory, entry.name);
        const content = await readFile(filePath, "utf8").catch(() => undefined);
        if (content === undefined) continue;
        const profile = parsePiAgentProfile(content, {
            fallbackName: basename(entry.name, ".md"),
            filePath,
            source: "user",
        });
        if (profile !== undefined) profiles.push(profile);
    }
    return profiles;
}

async function loadProjectProfiles(
    tools: DevshellPiToolSession,
): Promise<PiAgentProfile[]> {
    const names = new Set(tools.tools.map((tool) => tool.name));
    if (!names.has("file_glob") || !names.has("file_read")) return [];
    try {
        const result = asRecord(
            await tools.callTool(
                "file_glob",
                {
                    gitignore: false,
                    hidden: true,
                    patterns: ["./.pi/agents/*.md"],
                    type: "file",
                },
                "pi-agent-profiles-glob",
            ),
        );
        const entries = Array.isArray(result?.entries) ? result.entries : [];
        const paths = entries.flatMap((value) => {
            const entry = asRecord(value);
            return entry?.type === "file" && typeof entry.path === "string"
                ? [entry.path]
                : [];
        });
        const profiles: PiAgentProfile[] = [];
        for (const path of paths) {
            const content = await readRemoteText(tools, path);
            const profile = parsePiAgentProfile(content, {
                fallbackName: basename(path, ".md"),
                filePath: path,
                source: "project",
            });
            if (profile !== undefined) profiles.push(profile);
        }
        return profiles;
    } catch {
        return [];
    }
}

async function readRemoteText(
    tools: DevshellPiToolSession,
    path: string,
): Promise<string> {
    const lines = new Map<number, string>();
    let selector: string | undefined;
    let page = 0;
    do {
        const result = asRecord(
            await tools.callTool(
                "file_read",
                {
                    files: [
                        {
                            path,
                            view: "content",
                            ...(selector === undefined ? {} : { selector }),
                        },
                    ],
                },
                `pi-agent-profile-read-${++page}`,
            ),
        );
        const file = Array.isArray(result?.files)
            ? asRecord(result.files[0])
            : undefined;
        const content = typeof file?.content === "string" ? file.content : "";
        for (const line of content.split("\n")) {
            if (line.length === 0) continue;
            const match = /^(\d+):(.*)$/u.exec(line);
            if (match === null)
                throw new Error(`Malformed profile content for ${path}.`);
            lines.set(Number(match[1]), match[2] ?? "");
        }
        const next =
            typeof file?.nextSelector === "string"
                ? file.nextSelector
                : undefined;
        selector =
            next !== undefined && /^\d+$/u.test(next) ? `${next}:raw` : next;
    } while (selector !== undefined);
    return [...lines.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, line]) => line)
        .join("\n")
        .replace(/^\uFEFF/u, "");
}

function asRecord(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, JsonValue>)
        : undefined;
}
