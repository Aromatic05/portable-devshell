// Stateful control-plane instance registry projection. It owns only the
// authoritative, name-sorted instance list and the membership lifecycle
// actions (enable/disable/delete); a successful lifecycle action re-reads the
// registry so the snapshot stays authoritative. It never reaches into per-
// instance runtime state or configuration.
//
// Instance creation is deliberately not projected here: the create wizard state
// stays UI-local. `create`/`validateCreate`/`createSchema` are exposed only as
// thin transport delegates so the wizard can share this transport facade
// without this view model owning a draft or a wizard projection.
//
// A method-not-found `list` means the control API does not expose instance
// management at all. That is modelled explicitly as `supported: false` with no
// list and no failure, so a missing API is a stable capability signal rather
// than a permanent fatal projection; any other error stays in `failure`.
//
// `revision` is the stable snapshot identity: it only advances when the list
// actually changes, so identical re-reads keep the same projection identity.

import type { InstanceListEntry } from "../../../runtime/state/Model.js";
import type {
    InstanceCreateDraft,
    InstanceCreateResult,
    InstanceCreateSchema,
    InstanceCreateSummary,
} from "../create/Model.js";
import type { InstanceManagementTransport } from "../create/Transport.js";

export interface InstanceRegistryViewModelState {
    failure?: Error;
    /** Authoritative instance list, sorted by name. */
    instances: InstanceListEntry[];
    /** True while a read runs with no list to show yet. */
    loading: boolean;
    /** True while a read or lifecycle action runs with an existing list. */
    refreshing: boolean;
    /** Stable snapshot identity; advances only when the list changes. */
    revision: number;
    /** False once `list` reports that instance management is unsupported. */
    supported: boolean;
}

export class InstanceRegistryViewModel {
    readonly #listeners = new Set<() => void>();
    readonly #transport: InstanceManagementTransport;
    #epoch = 0;
    #generation = 0;
    #loaded = false;
    #published: InstanceRegistryViewModelState =
        emptyInstanceRegistryViewModelState();
    #revision = 0;
    #state: InstanceRegistryViewModelState =
        emptyInstanceRegistryViewModelState();

    constructor(transport: InstanceManagementTransport) {
        this.#transport = transport;
    }

    get state(): Readonly<InstanceRegistryViewModelState> {
        return this.#published;
    }

    getSnapshot(): Readonly<InstanceRegistryViewModelState> {
        return this.#published;
    }

    subscribe(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    /** Reads the authoritative registry. Alias of `refresh`. */
    list(): Promise<InstanceListEntry[] | undefined> {
        return this.#read();
    }

    /** Re-reads the authoritative registry. */
    refresh(): Promise<InstanceListEntry[] | undefined> {
        return this.#read();
    }

    /** Enables an instance, then refreshes the authoritative registry. */
    enable(instanceName: string): Promise<void> {
        return this.#mutate(() => this.#transport.enable(instanceName));
    }

    /** Disables an instance, then refreshes the authoritative registry. */
    disable(instanceName: string): Promise<void> {
        return this.#mutate(() => this.#transport.disable(instanceName));
    }

    /** Deletes an instance, then refreshes the authoritative registry. */
    delete(instanceName: string): Promise<void> {
        return this.#mutate(() => this.#transport.delete(instanceName));
    }

    /** Thin delegate; the create wizard owns the draft projection. */
    create(draft: InstanceCreateDraft): Promise<InstanceCreateResult> {
        return this.#transport.create(draft);
    }

    /** Thin delegate; the create wizard owns the draft projection. */
    createSchema(): Promise<InstanceCreateSchema> {
        return this.#transport.createSchema();
    }

    /** Thin delegate; the create wizard owns the draft projection. */
    validateCreate(draft: InstanceCreateDraft): Promise<InstanceCreateSummary> {
        return this.#transport.validateCreate(draft);
    }

    /** Releases listeners and prunes only this registry projection. */
    close(): void {
        this.#epoch += 1;
        this.#generation += 1;
        this.#loaded = false;
        this.#revision = 0;
        this.#listeners.clear();
        this.#state = emptyInstanceRegistryViewModelState();
        this.#published = this.#state;
    }

    async #read(): Promise<InstanceListEntry[] | undefined> {
        const epoch = this.#epoch;
        const generation = ++this.#generation;
        this.#begin();
        try {
            const instances = await this.#transport.list();
            if (epoch !== this.#epoch || generation !== this.#generation)
                return undefined;
            this.#apply(instances);
            return instances;
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

    async #mutate(run: () => Promise<unknown>): Promise<void> {
        const epoch = this.#epoch;
        const generation = ++this.#generation;
        this.#begin();
        try {
            await run();
        } catch (error) {
            if (epoch === this.#epoch && generation === this.#generation)
                this.#fail(error);
            throw error;
        }
        if (epoch !== this.#epoch) return;
        await this.#read();
    }

    #begin(): void {
        this.#state = {
            ...this.#state,
            loading: !this.#loaded,
            refreshing: this.#loaded,
        };
        this.#emit();
    }

    #apply(instances: readonly InstanceListEntry[]): void {
        const ordered = orderInstances(instances);
        const changed =
            !this.#loaded || !sameInstanceList(this.#state.instances, ordered);
        this.#loaded = true;
        this.#state = {
            failure: undefined,
            instances: ordered,
            loading: false,
            refreshing: false,
            revision: changed ? ++this.#revision : this.#revision,
            supported: true,
        };
        this.#emit();
    }

    #markUnsupported(): void {
        const changed = this.#loaded;
        this.#loaded = false;
        this.#state = {
            failure: undefined,
            instances: [],
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
        this.#published = this.#state;
        this.#state = { ...this.#state };
        for (const listener of this.#listeners) listener();
    }
}

function emptyInstanceRegistryViewModelState(): InstanceRegistryViewModelState {
    return {
        instances: [],
        loading: false,
        refreshing: false,
        revision: 0,
        supported: true,
    };
}

function orderInstances(
    instances: readonly InstanceListEntry[],
): InstanceListEntry[] {
    return [...instances].sort((left, right) =>
        left.name.localeCompare(right.name),
    );
}

function sameInstanceList(
    left: readonly InstanceListEntry[],
    right: readonly InstanceListEntry[],
): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

function isMethodNotFound(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        (error as { code?: unknown }).code === "method_not_found"
    );
}

function toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}
