import { pathToFileURL } from "node:url";

export interface PiModelLike {
    id: string;
    name?: string;
    provider: string;
    [key: string]: unknown;
}

export interface PiProviderLike {
    id: string;
    name?: string;
    [key: string]: unknown;
}

export interface PiAuthCheckLike {
    source?: string;
    type: "api_key" | "oauth";
}

export interface PiAuthPromptLike {
    message: string;
    type: "manual_code" | "secret" | "select" | "text";
}

export interface PiModelRuntimeLike {
    checkAuth(providerId: string): Promise<PiAuthCheckLike | undefined>;
    getModel(providerId: string, modelId: string): PiModelLike | undefined;
    getModels(providerId?: string): readonly PiModelLike[];
    getProviders(): readonly PiProviderLike[];
    login(
        providerId: string,
        type: "api_key" | "oauth",
        interaction: {
            notify(event: unknown): void;
            prompt(prompt: PiAuthPromptLike): Promise<string>;
            signal?: AbortSignal;
        }
    ): Promise<unknown>;
    logout(providerId: string): Promise<void>;
}

export interface PiSettingsManagerLike {
    flush(): Promise<void>;
    getDefaultModel(): string | undefined;
    getDefaultProvider(): string | undefined;
    getDefaultThinkingLevel(): string | undefined;
    setDefaultModelAndProvider(provider: string, modelId: string): void;
    setDefaultThinkingLevel(level: string): void;
}

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
    setModel?(model: PiModelLike): Promise<void>;
    setThinkingLevel?(level: string): void;
    subscribe?(listener: (event: unknown) => void): () => void;
}

export interface PiSdkModule {
    DefaultResourceLoader: new (options?: Record<string, unknown>) => {
        reload(): Promise<void>;
    };
    ModelRuntime: {
        create(options?: Record<string, unknown>): Promise<PiModelRuntimeLike>;
    };
    SessionManager: {
        create(cwd: string, sessionDir?: string): unknown;
    };
    SettingsManager: {
        create(cwd: string, agentDir?: string): PiSettingsManagerLike;
    };
    getAgentDir(): string;
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
            throw new Error("Bundled Pi package does not expose the expected SDK surface.");
        }
        return loaded;
    }
}

async function importPiModule(url: string): Promise<unknown> {
    return await import(url);
}

function isPiSdkModule(value: unknown): value is PiSdkModule {
    if (typeof value !== "object" || value === null) return false;
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.createAgentSession !== "function") return false;
    if (typeof candidate.getAgentDir !== "function") return false;
    if (typeof candidate.DefaultResourceLoader !== "function") return false;
    if (typeof candidate.ModelRuntime !== "function" && (typeof candidate.ModelRuntime !== "object" || candidate.ModelRuntime === null)) {
        return false;
    }
    if (typeof (candidate.ModelRuntime as { create?: unknown }).create !== "function") return false;
    if (typeof candidate.SettingsManager !== "function" && (typeof candidate.SettingsManager !== "object" || candidate.SettingsManager === null)) {
        return false;
    }
    if (typeof (candidate.SettingsManager as { create?: unknown }).create !== "function") return false;
    if (typeof candidate.SessionManager !== "function" && (typeof candidate.SessionManager !== "object" || candidate.SessionManager === null)) {
        return false;
    }
    return typeof (candidate.SessionManager as { create?: unknown }).create === "function";
}
