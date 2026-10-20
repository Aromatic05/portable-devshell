import type { ExtensionManifest } from "@portable-devshell/extension";
import type { ExtensionContextEnvironmentRetiredEvent } from "@portable-devshell/extension/context";
import type { ExtensionInstanceGenerationRetiredEvent } from "@portable-devshell/extension/instance";

import type { ExtensionRegistrationSet } from "./Registration.js";

export type ExtensionGenerationState =
    "active" | "disposed" | "dispose-failed" | "draining" | "faulted" | "ready";

export interface ExtensionGenerationOptions {
    contextEnvironmentRetired?: (
        event: ExtensionContextEnvironmentRetiredEvent,
    ) => Promise<void>;
    dispose: () => Promise<void>;
    generation: string;
    instanceGenerationRetired?: (
        event: ExtensionInstanceGenerationRetiredEvent,
    ) => Promise<void>;
    manifest: ExtensionManifest;
    registrations: ExtensionRegistrationSet;
    retireInstanceHostResources?: (instance: string) => Promise<void>;
}

export interface ExtensionGenerationLease {
    readonly generation: string;
    readonly manifest: ExtensionManifest;
    readonly registrations: ExtensionRegistrationSet;
    /** Signals long-lived consumers to reconnect when this runtime retires. */
    readonly retirementSignal: AbortSignal;
    release(): void;
}

export class ExtensionGeneration {
    readonly #faultListeners = new Set<() => void>();
    readonly #retirementController = new AbortController();
    readonly generation: string;
    readonly manifest: ExtensionManifest;
    readonly registrations: ExtensionRegistrationSet;
    readonly #contextEnvironmentRetired?: ExtensionGenerationOptions["contextEnvironmentRetired"];
    readonly #dispose: () => Promise<void>;
    readonly #instanceGenerationRetired?: ExtensionGenerationOptions["instanceGenerationRetired"];
    readonly #retireInstanceHostResources?: (instance: string) => Promise<void>;
    #retirement: Promise<void>;
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
        this.#contextEnvironmentRetired = options.contextEnvironmentRetired;
        this.#dispose = options.dispose;
        this.#instanceGenerationRetired = options.instanceGenerationRetired;
        this.#retireInstanceHostResources = options.retireInstanceHostResources;
        this.#retirement = this.#createRetirement();
    }

    #createRetirement(): Promise<void> {
        const retirement = new Promise<void>((resolve, reject) => {
            this.#resolveRetirement = resolve;
            this.#rejectRetirement = reject;
        });
        void retirement.catch(() => undefined);
        return retirement;
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
            throw new Error(
                `Extension generation ${this.generation} cannot activate from ${this.#state}.`,
            );
        }
        this.#state = "active";
    }

    acquire(): ExtensionGenerationLease {
        if (this.#state !== "active") {
            throw new Error(
                `Extension generation ${this.generation} is not active.`,
            );
        }
        return this.#acquireLease();
    }

    /** Host lifecycle cleanup must also pin a faulted runtime awaiting recovery. */
    acquireLifecycleLease(): ExtensionGenerationLease {
        if (this.#state !== "active" && this.#state !== "faulted") {
            throw new Error(
                `Extension generation ${this.generation} cannot handle lifecycle events from ${this.#state}.`,
            );
        }
        return this.#acquireLease();
    }

    #acquireLease(): ExtensionGenerationLease {
        this.#inFlight += 1;
        let released = false;
        return {
            generation: this.generation,
            manifest: this.manifest,
            registrations: this.registrations,
            retirementSignal: this.#retirementController.signal,
            release: () => {
                if (released) return;
                released = true;
                this.#inFlight -= 1;
                this.#maybeDispose();
            },
        };
    }

    async contextEnvironmentRetired(
        event: ExtensionContextEnvironmentRetiredEvent,
    ): Promise<void> {
        await this.#contextEnvironmentRetired?.(event);
    }

    async instanceGenerationRetired(
        event: ExtensionInstanceGenerationRetiredEvent,
    ): Promise<void> {
        await this.#instanceGenerationRetired?.(event);
    }

    async retireInstanceHostResources(instance: string): Promise<void> {
        await this.#retireInstanceHostResources?.(instance);
    }

    fault(error: unknown): void {
        if (this.#state !== "ready" && this.#state !== "active") return;
        this.#faultError = error;
        this.#state = "faulted";
        for (const listener of this.#faultListeners) listener();
    }

    onFault(listener: () => void): () => void {
        this.#faultListeners.add(listener);
        return () => this.#faultListeners.delete(listener);
    }

    retire(): Promise<void> {
        this.#faultListeners.clear();
        if (this.#state === "dispose-failed") {
            this.#retirement = this.#createRetirement();
            this.#disposeStarted = false;
            this.#state = "draining";
            this.#maybeDispose();
        }
        if (
            this.#state === "ready" ||
            this.#state === "active" ||
            this.#state === "faulted"
        ) {
            this.#state = "draining";
            this.#retirementController.abort(new Error("Extension generation retired."));
            this.#maybeDispose();
        }
        return this.#retirement;
    }

    #maybeDispose(): void {
        if (
            this.#state !== "draining" ||
            this.#inFlight !== 0 ||
            this.#disposeStarted
        )
            return;
        this.#disposeStarted = true;
        void this.#dispose().then(
            () => {
                this.#disposeError = undefined;
                this.#state = "disposed";
                this.#resolveRetirement();
            },
            (error: unknown) => {
                this.#disposeError = error;
                this.#state = "dispose-failed";
                this.#rejectRetirement(error);
            },
        );
    }
}
