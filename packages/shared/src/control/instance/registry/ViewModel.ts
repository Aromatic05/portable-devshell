// Stateful control-plane instance registry projection. It owns only the
// authoritative, name-sorted instance list and the membership lifecycle
// actions (enable/disable/delete); a successful lifecycle action re-reads the
// registry so the snapshot stays authoritative. It never reaches into per-
// instance runtime state or configuration.
//
// The authoritative list is a revision-bearing envelope. After the first read
// the projection opens one cursor-resumable change subscription at
// `revision + 1`, coalesces live change signals into a single authoritative
// re-read, and recovers a `stream.gap` by re-reading the list and resuming at
// the fresh `revision + 1`. The feed sits in front of the list; it is never
// treated as the list itself.
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

import type { InstanceListEntry } from "../../../runtime/state/Model.js";
import {
    EventSubscription,
    type SubscriptionStatus,
} from "../../../transport/stream/Subscription.js";
import {
    readInstanceChangeStreamGap,
    type InstanceChangeStreamPort,
} from "../create/Contract.js";
import type {
    InstanceChangeEvent,
    InstanceCreateDraft,
    InstanceCreateResult,
    InstanceCreateSchema,
    InstanceCreateSummary,
    InstanceListEnvelope,
} from "../create/Model.js";
import type { InstanceManagementTransport } from "../create/Transport.js";

export interface InstanceRegistryViewModelState {
    /** Live state of the change subscription feeding the list. */
    connection: SubscriptionStatus;
    failure?: Error;
    /** Authoritative instance list, sorted by name. */
    instances: InstanceListEntry[];
    /** True while a read runs with no list to show yet. */
    loading: boolean;
    /** True while a read or lifecycle action runs with an existing list. */
    refreshing: boolean;
    /** Authoritative list revision; the subscription resumes at `revision + 1`. */
    revision: number;
    /** False once `list` reports that instance management is unsupported. */
    supported: boolean;
}

const REFRESH_COALESCE_MS = 100;

export class InstanceRegistryViewModel {
    readonly #listeners = new Set<() => void>();
    readonly #transport: InstanceManagementTransport;
    #epoch = 0;
    #generation = 0;
    #loaded = false;
    #published: InstanceRegistryViewModelState =
        emptyInstanceRegistryViewModelState();
    #refreshTimer?: ReturnType<typeof setTimeout>;
    #state: InstanceRegistryViewModelState =
        emptyInstanceRegistryViewModelState();
    #subscription?: EventSubscription<InstanceChangeEvent>;

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
    list(): Promise<InstanceListEnvelope | undefined> {
        return this.#read();
    }

    /** Re-reads the authoritative registry. */
    refresh(): Promise<InstanceListEnvelope | undefined> {
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
        if (this.#refreshTimer !== undefined) {
            clearTimeout(this.#refreshTimer);
            this.#refreshTimer = undefined;
        }
        this.#stopSubscription();
        this.#listeners.clear();
        this.#state = emptyInstanceRegistryViewModelState();
        this.#published = this.#state;
    }

    async #read(): Promise<InstanceListEnvelope | undefined> {
        const epoch = this.#epoch;
        const generation = ++this.#generation;
        this.#begin();
        try {
            const envelope = await this.#transport.snapshot();
            if (epoch !== this.#epoch || generation !== this.#generation)
                return undefined;
            this.#apply(envelope);
            this.#ensureSubscription(envelope.revision + 1);
            return envelope;
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

    #apply(envelope: InstanceListEnvelope): void {
        this.#loaded = true;
        this.#state = {
            ...this.#state,
            failure: undefined,
            instances: orderInstances(envelope.instances),
            loading: false,
            refreshing: false,
            revision: envelope.revision,
            supported: true,
        };
        this.#emit();
    }

    #markUnsupported(): void {
        this.#stopSubscription();
        this.#state = {
            connection: "stopped",
            failure: undefined,
            instances: [],
            loading: false,
            refreshing: false,
            revision: this.#state.revision,
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

    #ensureSubscription(fromRevision: number): void {
        if (this.#subscription !== undefined) return;
        this.#subscription = new EventSubscription<InstanceChangeEvent>(
            fromRevision,
            {
                eventSeq: (event) => event.revision,
                onEvent: (event) => this.#onEvent(event),
                onGap: () => this.#recover(),
                onStatusChange: (status) => {
                    this.#state = { ...this.#state, connection: status };
                    this.#emit();
                },
                open: (cursor) => this.#open(cursor),
                readGapError: readInstanceChangeStreamGap,
            },
        );
        this.#subscription.start();
    }

    #stopSubscription(): void {
        this.#subscription?.stop();
        this.#subscription = undefined;
    }

    #open(fromRevision: number): Promise<InstanceChangeStreamPort> {
        return this.#transport.subscribe(fromRevision);
    }

    #onEvent(event: InstanceChangeEvent): void {
        if (event.revision <= this.#state.revision) return;
        this.#scheduleRefresh();
    }

    #scheduleRefresh(): void {
        if (this.#refreshTimer !== undefined) return;
        this.#refreshTimer = setTimeout(() => {
            this.#refreshTimer = undefined;
            void this.#read();
        }, REFRESH_COALESCE_MS);
    }

    async #recover(): Promise<number | undefined> {
        const envelope = await this.#read();
        return envelope === undefined ? undefined : envelope.revision + 1;
    }

    #emit(): void {
        this.#published = this.#state;
        this.#state = { ...this.#state };
        for (const listener of this.#listeners) listener();
    }
}

function emptyInstanceRegistryViewModelState(): InstanceRegistryViewModelState {
    return {
        connection: "stopped",
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
