import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

import { isPiAgentName } from "../subagent/Namespace.js";

export type PiAgentProfileSource = "project" | "user";

export interface PiAgentProfile {
    readonly candidateModels: readonly string[];
    readonly filePath: string;
    readonly name: string;
    readonly prompt: string;
    readonly source: PiAgentProfileSource;
}

type ProfileFrontmatter = {
    model?: unknown;
    models?: unknown;
    name?: unknown;
};

export function parsePiAgentProfile(
    content: string,
    options: {
        fallbackName: string;
        filePath: string;
        source: PiAgentProfileSource;
    },
): PiAgentProfile | undefined {
    const { body, frontmatter } = parseFrontmatter<ProfileFrontmatter>(content);
    const name =
        typeof frontmatter.name === "string"
            ? frontmatter.name.trim()
            : options.fallbackName;
    if (!isPiAgentName(name)) return undefined;
    const prompt = body.trim();
    if (prompt.length === 0) return undefined;
    return {
        candidateModels: parseCandidateModels(
            frontmatter.models ?? frontmatter.model,
        ),
        filePath: options.filePath,
        name,
        prompt,
        source: options.source,
    };
}

function parseCandidateModels(value: unknown): string[] {
    const values = Array.isArray(value)
        ? value
        : typeof value === "string"
          ? value.split(",")
          : [];
    return [
        ...new Set(
            values
                .filter((entry): entry is string => typeof entry === "string")
                .map((entry) => entry.trim())
                .filter(Boolean),
        ),
    ];
}
