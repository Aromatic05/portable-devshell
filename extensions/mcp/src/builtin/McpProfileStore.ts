import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface McpProfile {
    readonly name: string;
    readonly url: string;
}

interface McpProfileDocument {
    profiles: McpProfile[];
    version: 1;
}

export class McpProfileStore {
    readonly #path: string;
    #mutation: Promise<void> = Promise.resolve();

    constructor(stateDirectory: string) {
        this.#path = join(stateDirectory, "profiles.json");
    }

    async list(): Promise<readonly McpProfile[]> {
        return [...(await this.#read()).profiles].sort((left, right) => left.name.localeCompare(right.name));
    }

    async get(name: string): Promise<McpProfile | undefined> {
        return (await this.#read()).profiles.find((profile) => profile.name === name);
    }

    async add(profile: McpProfile): Promise<McpProfile> {
        return await this.#mutate(async (document) => {
            if (document.profiles.some((candidate) => candidate.name === profile.name)) {
                throw new Error(`MCP profile ${profile.name} already exists.`);
            }
            document.profiles.push(profile);
            return profile;
        });
    }

    async remove(name: string): Promise<McpProfile> {
        return await this.#mutate(async (document) => {
            const index = document.profiles.findIndex((profile) => profile.name === name);
            if (index < 0) throw new Error(`MCP profile ${name} does not exist.`);
            return document.profiles.splice(index, 1)[0]!;
        });
    }

    async #mutate<T>(change: (document: McpProfileDocument) => Promise<T> | T): Promise<T> {
        let resolveResult!: (value: T) => void;
        let rejectResult!: (error: unknown) => void;
        const result = new Promise<T>((resolve, reject) => {
            resolveResult = resolve;
            rejectResult = reject;
        });
        this.#mutation = this.#mutation.then(async () => {
            try {
                const document = await this.#read();
                const value = await change(document);
                await this.#write(document);
                resolveResult(value);
            } catch (error) {
                rejectResult(error);
            }
        });
        await this.#mutation;
        return await result;
    }

    async #read(): Promise<McpProfileDocument> {
        let raw: string;
        try {
            raw = await readFile(this.#path, "utf8");
        } catch (error) {
            if (isNotFound(error)) return { profiles: [], version: 1 };
            throw error;
        }
        return parseDocument(JSON.parse(raw) as unknown);
    }

    async #write(document: McpProfileDocument): Promise<void> {
        await mkdir(dirname(this.#path), { mode: 0o700, recursive: true });
        const temporary = `${this.#path}.${randomUUID()}.tmp`;
        try {
            await writeFile(temporary, `${JSON.stringify(document, null, 4)}\n`, { encoding: "utf8", mode: 0o600 });
            await rename(temporary, this.#path);
        } finally {
            await rm(temporary, { force: true }).catch(() => undefined);
        }
    }
}

export function validateMcpProfile(name: string, urlText: string): McpProfile {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(name)) {
        throw new TypeError("MCP profile name must contain only letters, numbers, dot, underscore, or hyphen.");
    }
    let url: URL;
    try {
        url = new URL(urlText);
    } catch (error) {
        throw new TypeError("MCP profile URL must be an absolute http(s) URL.", { cause: error });
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new TypeError("MCP profile URL must use http or https.");
    }
    if (url.username.length > 0 || url.password.length > 0) {
        throw new TypeError("MCP profile URL must not embed credentials.");
    }
    url.hash = "";
    return Object.freeze({ name, url: url.href });
}

function parseDocument(value: unknown): McpProfileDocument {
    if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.profiles)) {
        throw new TypeError("MCP profile store is invalid.");
    }
    const profiles = value.profiles.map((profile) => {
        if (!isRecord(profile) || typeof profile.name !== "string" || typeof profile.url !== "string") {
            throw new TypeError("MCP profile store contains an invalid profile.");
        }
        return validateMcpProfile(profile.name, profile.url);
    });
    const names = new Set<string>();
    for (const profile of profiles) {
        if (names.has(profile.name)) throw new TypeError(`MCP profile store contains duplicate profile ${profile.name}.`);
        names.add(profile.name);
    }
    return { profiles: [...profiles], version: 1 };
}

function isNotFound(error: unknown): boolean {
    return isRecord(error) && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
