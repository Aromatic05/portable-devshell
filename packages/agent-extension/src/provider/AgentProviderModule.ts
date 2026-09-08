import type { AgentProvider } from "./AgentProvider.js";

export const AGENT_PROVIDER_API_VERSION = 1;

export interface AgentProviderManifest {
    apiVersion: number;
    entry: string;
    id: string;
    name: string;
    schemaVersion: number;
    version: string;
}

export interface AgentProviderModule {
    createAgentProvider(): AgentProvider | Promise<AgentProvider>;
}

export function parseAgentProviderManifest(value: unknown): AgentProviderManifest {
    if (!isRecord(value)) throw new TypeError("Agent provider manifest must be an object.");
    const keys = Object.keys(value).sort();
    const expected = ["apiVersion", "entry", "id", "name", "schemaVersion", "version"];
    if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
        throw new TypeError("Agent provider manifest has unknown or missing fields.");
    }
    if (value.schemaVersion !== 1) throw new TypeError("Unsupported Agent provider manifest schema version.");
    if (!Number.isInteger(value.apiVersion) || Number(value.apiVersion) < 1) {
        throw new TypeError("Agent provider apiVersion must be a positive integer.");
    }
    const id = readString(value.id, "id");
    if (!/^[a-z0-9][a-z0-9._-]*$/u.test(id)) throw new TypeError(`Invalid Agent provider id: ${id}`);
    return Object.freeze({
        apiVersion: Number(value.apiVersion),
        entry: readString(value.entry, "entry"),
        id,
        name: readString(value.name, "name"),
        schemaVersion: 1,
        version: readString(value.version, "version")
    });
}

function readString(value: unknown, name: string): string {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new TypeError(`Agent provider ${name} must be a non-empty string.`);
    }
    return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
