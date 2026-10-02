// Stateful configuration projection. It owns only the control config view and
// the config editor actions and never reaches into another domain. `get` reads
// the authoritative ConfigView; every successful update returns a fresh
// ConfigView that is folded straight back into the projection. Read and write
// requests share one monotonic generation so a slow response can never
// overwrite a newer projection.
//
// A method-not-found `get` means the control API does not expose configuration
// at all. That is modelled explicitly as `supported: false` with no view and no
// failure, so a missing API is a stable capability signal rather than a
// permanent fatal projection; any other error stays in `failure`.
//
// `revision` is the stable snapshot identity: it only advances when the view
// actually changes, so identical re-reads keep the same projection identity.

import type {
    ConfigBatchUpdateRequest,
    ConfigDraft,
    ConfigUpdateInstanceRequest,
    ConfigUpdateMcpRequest,
    ConfigUpdateWebRequest,
    ConfigView,
} from "./Edit.js";
import type { ConfigTransport } from "./Transport.js";

export interface ConfigViewModelState {
    failure?: Error;
    /** True while a read runs with no projection to show yet. */
    loading: boolean;
    /** True while a read or update runs with an existing projection. */
    refreshing: boolean;
    /** Stable snapshot identity; advances only when the view changes. */
    revision: number;
    /** False once `get` reports that the config API is unsupported. */
    supported: boolean;
    view?: ConfigView;
}

export class ConfigViewModel {
    readonly #listeners = new Set<() => void>();
    readonly #transport: ConfigTransport;
    #epoch = 0;
    #generation = 0;
    #published: ConfigViewModelState = emptyConfigViewModelState();
    #revision = 0;
    #state: ConfigViewModelState = emptyConfigViewModelState();

    constructor(transport: ConfigTransport) {
        this.#transport = transport;
    }

    get state(): Readonly<ConfigViewModelState> {
        return this.#published;
    }

    subscribe(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    /** Reads the authoritative configuration. Alias of `refresh`. */
    get(): Promise<ConfigView | undefined> {
        return this.#read();
    }

    /** Re-reads the authoritative configuration. */
    refresh(): Promise<ConfigView | undefined> {
        return this.#read();
    }

    async update(request: ConfigBatchUpdateRequest): Promise<ConfigView> {
        return await this.#mutate(() => this.#transport.update(request));
    }

    async updateInstance(
        request: ConfigUpdateInstanceRequest,
    ): Promise<ConfigView> {
        return await this.#mutate(() =>
            this.#transport.updateInstance(request),
        );
    }

    async updateMcpEndpoint(
        request: ConfigUpdateMcpRequest,
    ): Promise<ConfigView> {
        return await this.#mutate(() =>
            this.#transport.updateMcpEndpoint(request),
        );
    }

    async updateWeb(request: ConfigUpdateWebRequest): Promise<ConfigView> {
        return await this.#mutate(() => this.#transport.updateWeb(request));
    }

    /** Validates a draft without persisting it, so the projection is untouched. */
    validate(draft: ConfigDraft): Promise<ConfigView> {
        return this.#transport.validate(draft);
    }

    close(): void {
        this.#epoch += 1;
        this.#generation += 1;
        this.#revision = 0;
        this.#listeners.clear();
        this.#state = emptyConfigViewModelState();
        this.#published = Object.freeze(this.#state);
    }

    async #read(): Promise<ConfigView | undefined> {
        const epoch = this.#epoch;
        const generation = ++this.#generation;
        this.#begin();
        try {
            const view = await this.#transport.get();
            if (epoch !== this.#epoch || generation !== this.#generation)
                return undefined;
            this.#apply(view);
            return view;
        } catch (error) {
            if (epoch !== this.#epoch || generation !== this.#generation)
                return undefined;
            if (isMethodNotFound(error)) {
                this.#markUnsupported();
                return undefined;
            }
            this.#fail(error);
            return undefined;
        }
    }

    async #mutate(request: () => Promise<ConfigView>): Promise<ConfigView> {
        const epoch = this.#epoch;
        const generation = ++this.#generation;
        this.#begin();
        try {
            const view = await request();
            if (epoch !== this.#epoch) return view;
            if (generation === this.#generation) this.#apply(view);
            else await this.#read();
            return view;
        } catch (error) {
            if (epoch === this.#epoch && generation === this.#generation)
                this.#fail(error);
            throw error;
        }
    }

    #begin(): void {
        const hasView = this.#state.view !== undefined;
        this.#state = {
            ...this.#state,
            loading: !hasView,
            refreshing: hasView,
        };
        this.#emit();
    }

    #apply(view: ConfigView): void {
        const current = this.#state.view;
        const changed = current === undefined || !sameConfigView(current, view);
        this.#state = {
            failure: undefined,
            loading: false,
            refreshing: false,
            revision: changed ? ++this.#revision : this.#revision,
            supported: true,
            view: changed ? view : current,
        };
        this.#emit();
    }

    #markUnsupported(): void {
        const changed = this.#state.view !== undefined;
        this.#state = {
            failure: undefined,
            loading: false,
            refreshing: false,
            revision: changed ? ++this.#revision : this.#revision,
            supported: false,
        };
        this.#emit();
    }

    #fail(error: unknown): void {
        this.#state = {
            ...this.#state,
            failure: toError(error),
            loading: false,
            refreshing: false,
        };
        this.#emit();
    }

    #emit(): void {
        this.#published = Object.freeze(this.#state);
        this.#state = { ...this.#published };
        for (const listener of this.#listeners) listener();
    }
}

function emptyConfigViewModelState(): ConfigViewModelState {
    return { loading: false, refreshing: false, revision: 0, supported: true };
}

function isMethodNotFound(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        (error as { code?: unknown }).code === "method_not_found"
    );
}

function sameConfigView(left: ConfigView, right: ConfigView): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

function toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}
