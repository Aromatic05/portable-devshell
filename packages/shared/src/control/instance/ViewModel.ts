import {
    EventSubscription,
    type SubscriptionStatus,
} from "../../client/Stream.js";
import { type InstanceListEntry } from "../../execution/process/Model.js";
import {
    type InstanceChangeEvent,
    type InstanceCreateDraft,
    type InstanceCreateResult,
    type InstanceCreateSchema,
    type InstanceCreateSummary,
    type InstanceListEnvelope,
} from "./Model.js";
import {
    type InstanceChangeStreamPort,
    readInstanceChangeStreamGap,
} from "./Revision.js";
import type { InstanceTransport } from "./Transport.js";

export interface InstanceConfigViewModelState {
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
    /** False once the instance-config catalog reports unsupported operations. */
    supported: boolean;
}
const INSTANCE_REFRESH_COALESCE_MS = 100;
export class InstanceConfigViewModel {
    readonly #listeners = new Set<() => void>();
    readonly #transport: InstanceTransport;
    #epoch = 0;
    #generation = 0;
    #loaded = false;
    #published: InstanceConfigViewModelState =
        emptyInstanceConfigViewModelState();
    #refreshTimer?: ReturnType<typeof setTimeout>;
    #state: InstanceConfigViewModelState = emptyInstanceConfigViewModelState();
    #subscription?: EventSubscription<InstanceChangeEvent>;

    constructor(transport: InstanceTransport) {
        this.#transport = transport;
    }

    get state(): Readonly<InstanceConfigViewModelState> {
        return this.#published;
    }

    getSnapshot(): Readonly<InstanceConfigViewModelState> {
        return this.#published;
    }

    subscribe(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    /** Reads the authoritative configured-instance catalog. Alias of `refresh`. */
    list(): Promise<InstanceListEnvelope | undefined> {
        return this.#read();
    }

    /** Re-reads the authoritative configured-instance catalog. */
    refresh(): Promise<InstanceListEnvelope | undefined> {
        return this.#read();
    }

    /** Enables an instance, then refreshes the configured-instance catalog. */
    enable(instanceName: string): Promise<void> {
        return this.#mutate(() => this.#transport.enableInstance(instanceName));
    }

    /** Disables an instance, then refreshes the configured-instance catalog. */
    disable(instanceName: string): Promise<void> {
        return this.#mutate(() =>
            this.#transport.disableInstance(instanceName),
        );
    }

    /** Deletes an instance, then refreshes the configured-instance catalog. */
    delete(instanceName: string): Promise<void> {
        return this.#mutate(() => this.#transport.deleteInstance(instanceName));
    }

    /** Thin delegate; the create wizard owns the draft projection. */
    create(draft: InstanceCreateDraft): Promise<InstanceCreateResult> {
        return this.#transport.createInstance(draft);
    }

    /** Thin delegate; the create wizard owns the draft projection. */
    createSchema(): Promise<InstanceCreateSchema> {
        return this.#transport.createInstanceSchema();
    }

    /** Thin delegate; the create wizard owns the draft projection. */
    validateCreate(draft: InstanceCreateDraft): Promise<InstanceCreateSummary> {
        return this.#transport.validateInstanceCreate(draft);
    }

    /** Releases listeners and resets only this instance-config projection. */
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
        this.#state = emptyInstanceConfigViewModelState();
        this.#published = this.#state;
    }

    async #read(): Promise<InstanceListEnvelope | undefined> {
        const epoch = this.#epoch;
        const generation = ++this.#generation;
        this.#begin();
        try {
            const envelope = await this.#transport.snapshotInstances();
            if (epoch !== this.#epoch || generation !== this.#generation)
                return undefined;
            this.#apply(envelope);
            this.#ensureSubscription(envelope.revision + 1);
            return envelope;
        } catch (error) {
            if (epoch !== this.#epoch || generation !== this.#generation)
                return undefined;
            if (isInstanceMethodNotFound(error)) {
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
            failure: toInstanceError(error),
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
        return this.#transport.subscribeInstances(fromRevision);
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
        }, INSTANCE_REFRESH_COALESCE_MS);
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
function emptyInstanceConfigViewModelState(): InstanceConfigViewModelState {
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
function isInstanceMethodNotFound(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        (error as { code?: unknown }).code === "method_not_found"
    );
}
function toInstanceError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}
