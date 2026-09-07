import type { ExtensionActivation, ExtensionManifest } from "@portable-devshell/extension";

export type ExtensionGenerationState = "active" | "disposed" | "dispose-failed" | "draining" | "ready";

export interface ExtensionGenerationOptions {
    activation: ExtensionActivation;
    dispose: () => Promise<void>;
    generation: string;
    manifest: ExtensionManifest;
}

export interface ExtensionGenerationLease {
    readonly activation: ExtensionActivation;
    readonly generation: string;
    readonly manifest: ExtensionManifest;
    release(): void;
}

export class ExtensionGeneration {
    readonly activation: ExtensionActivation;
    readonly generation: string;
    readonly manifest: ExtensionManifest;
    readonly #dispose: () => Promise<void>;
    readonly #retirement: Promise<void>;
    #disposeError?: unknown;
    #disposeStarted = false;
    #inFlight = 0;
    #rejectRetirement!: (error: unknown) => void;
    #resolveRetirement!: () => void;
    #state: ExtensionGenerationState = "ready";

    constructor(options: ExtensionGenerationOptions) {
        this.activation = options.activation;
        this.generation = options.generation;
        this.manifest = options.manifest;
        this.#dispose = options.dispose;
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
            activation: this.activation,
            generation: this.generation,
            manifest: this.manifest,
            release: () => {
                if (released) return;
                released = true;
                this.#inFlight -= 1;
                this.#maybeDispose();
            }
        };
    }

    retire(): Promise<void> {
        if (this.#state === "ready" || this.#state === "active") {
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
