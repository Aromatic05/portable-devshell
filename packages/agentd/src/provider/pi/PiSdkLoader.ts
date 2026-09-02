import { pathToFileURL } from "node:url";

export interface PiSessionLike {
    agent?: {
        state?: {
            isStreaming?: boolean;
            messages?: unknown[];
            model?: unknown;
            thinkingLevel?: unknown;
        };
    };
    abort(): Promise<void>;
    dispose(): void;
    prompt(text: string, options?: { streamingBehavior?: "steer" | "followUp" }): Promise<void>;
    subscribe?(listener: (event: unknown) => void): () => void;
}

export interface PiSdkModule {
    DefaultResourceLoader: new (options?: Record<string, unknown>) => {
        reload(): Promise<void>;
    };
    SessionManager: {
        create(cwd: string, sessionDir?: string): unknown;
    };
    createAgentSession(options?: Record<string, unknown>): Promise<{
        session: PiSessionLike;
    }>;
}

export type PiSdkImporter = (url: string) => Promise<unknown>;

export class PiSdkLoader {
    readonly #importer: PiSdkImporter;

    constructor(importer: PiSdkImporter = importPiModule) {
        this.#importer = importer;
    }

    async load(entrypoint: string): Promise<PiSdkModule> {
        const loaded = await this.#importer(pathToFileURL(entrypoint).href);
        if (!isPiSdkModule(loaded)) {
            throw new Error("Installed Pi package does not expose the expected SDK surface.");
        }
        return loaded;
    }
}

async function importPiModule(url: string): Promise<unknown> {
    return await import(url);
}

function isPiSdkModule(value: unknown): value is PiSdkModule {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.createAgentSession !== "function") {
        return false;
    }
    if (typeof candidate.DefaultResourceLoader !== "function") {
        return false;
    }
    if (typeof candidate.SessionManager !== "function" && (typeof candidate.SessionManager !== "object" || candidate.SessionManager === null)) {
        return false;
    }
    return typeof (candidate.SessionManager as { create?: unknown }).create === "function";
}
