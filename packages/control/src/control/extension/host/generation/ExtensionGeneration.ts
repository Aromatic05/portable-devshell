import type { ExtensionManifest } from "@portable-devshell/extension";

import type { ExtensionRegistrationSet } from "./ExtensionRegistration.js";

export type ExtensionGenerationState = "active" | "disposed" | "dispose-failed" | "draining" | "faulted" | "ready";

export interface ExtensionGenerationOptions {
    dispose: () => Promise<void>;
    generation: string;
    manifest: ExtensionManifest;
    registrations: ExtensionRegistrationSet;
    retireInstanceResources?: (instance: string) => Promise<void>;
}

export interface ExtensionGenerationLease {
    readonly generation: string;
    readonly manifest: ExtensionManifest;
    readonly registrations: ExtensionRegistrationSet;
    release(): void;
}

export class ExtensionGeneration {
    readonly generation: string;
    readonly manifest: ExtensionManifest;
    readonly registrations: ExtensionRegistrationSet;
    readonly #dispose: () => Promise<void>;
    readonly #retireInstanceResources?: (instance: string) => Promise<void>;
    readonly #retirement: Promise<void>;
    #disposeError?: unknown;
    #faultError?: unknown;
    #disposeStarted = false;
    #inFlight = 0;
    #rejectRetirement!: (error: unknown) => void;
    #resolveRetirement!: () => void;
    #state: ExtensionGenerationState = "ready";

    constructor(options: ExtensionGenerationOptions) {
        this.generation = options.generation;
        this.manifest = options.manifest;
        this.registrations = options.registrations;
        this.#dispose = options.dispose;
        this.#retireInstanceResources = options.retireInstanceResources;
        this.#retirement = new Promise<void>((resolve, reject) => {
            this.#resolveRetirement = resolve;
            this.#rejectRetirement = reject;
        });
        void this.#retirement.catch(() => undefined);
    }

    get disposeError(): unknown {
        return this.#disposeError;
    }

    get inFlight(): number {
        return this.#inFlight;
    }

    get faultError(): unknown {
        return this.#faultError;
    }

    get state(): ExtensionGenerationState {
        return this.#state;
    }

    activate(): void {
        if (this.#state !== "ready") {
            throw new Error(`Extension generation ${this.generation} cannot activate from ${this.#state}.`);
        }
        this.#state = "active";
    }

    acquire(): ExtensionGenerationLease {
        if (this.#state !== "active") {
            throw new Error(`Extension generation ${this.generation} is not active.`);
        }
        this.#inFlight += 1;
        let released = false;
        return {
            generation: this.generation,
            manifest: this.manifest,
            registrations: this.registrations,
            release: () => {
                if (released) return;
                released = true;
                this.#inFlight -= 1;
                this.#maybeDispose();
            }
        };
    }

    async retireInstanceResources(instance: string): Promise<void> {
        await this.#retireInstanceResources?.(instance);
    }

    fault(error: unknown): void {
        if (this.#state !== "ready" && this.#state !== "active") return;
        this.#faultError = error;
        this.#state = "faulted";
    }

    retire(): Promise<void> {
        if (this.#state === "ready" || this.#state === "active" || this.#state === "faulted") {
            this.#state = "draining";
            this.#maybeDispose();
        }
        return this.#retirement;
    }

    #maybeDispose(): void {
        if (this.#state !== "draining" || this.#inFlight !== 0 || this.#disposeStarted) return;
        this.#disposeStarted = true;
        void this.#dispose().then(
            () => {
                this.#state = "disposed";
                this.#resolveRetirement();
            },
            (error: unknown) => {
                this.#disposeError = error;
                this.#state = "dispose-failed";
                this.#rejectRetirement(error);
            }
        );
    }
}
