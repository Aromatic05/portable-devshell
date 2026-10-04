// Stateful extension control projection. Owns the installed runtime catalog,
// the optional TUI page catalog with its per-page snapshot cache, and the
// optional Web application/page catalogs with their per-page snapshot caches.
// Extension mutations and page reads/actions update only this extension state;
// the projection never reaches into another control domain.
//
// Catalogs come from a revisioned authoritative snapshot, followed by a
// resumable subscription. Page snapshots remain explicit reads/actions.

import type {
    ExtensionChangeEvent,
    ExtensionPublicRuntimeRecord,
    ExtensionRemoveResult,
    ExtensionRuntimeRecord,
    TuiPageDescriptor,
    TuiPageSnapshot,
    WebApplicationDescriptor,
    WebPageDescriptor,
    WebPageSnapshot,
} from "./Model.js";
import type {
    ExtensionRuntimeTransport,
    TuiPageTransport,
    WebPageTransport,
} from "./Transport.js";
import { EventSubscription, readStreamGap } from "../../client/Stream.js";

export interface ExtensionViewModelState {
    extensions: ExtensionPublicRuntimeRecord[];
    revision: number;
    extensionsFailure?: Error;
    /** Failure of the most recent TUI catalog read or page read/action. */
    tuiFailure?: Error;
    tuiPages: TuiPageDescriptor[];
    /** Per-page snapshots, keyed by page id. */
    tuiSnapshots: ReadonlyMap<string, TuiPageSnapshot>;
    /** False once `tui.pages` reports the catalog API as unsupported. */
    tuiSupported: boolean;
    webApplications: WebApplicationDescriptor[];
    /** Failure of the most recent Web catalog read or page read/action. */
    webFailure?: Error;
    webPages: WebPageDescriptor[];
    /** Per-page snapshots, keyed by page id. */
    webSnapshots: ReadonlyMap<string, WebPageSnapshot>;
    /** False once `web.applications`/`web.pages` report the catalog API as unsupported. */
    webSupported: boolean;
}

export class ExtensionViewModel {
    readonly #listeners = new Set<() => void>();
    readonly #runtime: ExtensionRuntimeTransport;
    readonly #tui: TuiPageTransport;
    readonly #versions = new Map<string, number>();
    readonly #web: WebPageTransport;
    #epoch = 0;
    #subscription?: EventSubscription<ExtensionChangeEvent>;
    #refresh?: Promise<number | undefined>;
    #refreshDirty = false;
    #pendingRevision = 0;
    #refreshTimer?: ReturnType<typeof setTimeout>;
    #published: Readonly<ExtensionViewModelState> = emptyState();
    #state: ExtensionViewModelState = emptyState();

    constructor(
        runtime: ExtensionRuntimeTransport,
        tui: TuiPageTransport,
        web: WebPageTransport,
    ) {
        this.#runtime = runtime;
        this.#tui = tui;
        this.#web = web;
    }

    get state(): Readonly<ExtensionViewModelState> {
        return this.#published;
    }

    getSnapshot(): Readonly<ExtensionViewModelState> {
        return this.#published;
    }

    subscribe(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    /** Reads the runtime, TUI, and Web catalogs once. */
    async refreshCatalogs(): Promise<void> {
        const epoch = this.#epoch;
        const revision = await this.#refreshSnapshot(epoch);
        if (revision !== undefined) this.#startSubscription(epoch);
    }

    install(sourcePath: string): Promise<ExtensionRuntimeRecord> {
        return this.#mutateExtensions(
            () => this.#runtime.install(sourcePath),
            (record) => this.#upsertExtension(record),
        );
    }

    enable(extensionId: string): Promise<ExtensionRuntimeRecord> {
        return this.#mutateExtensions(
            () => this.#runtime.enable(extensionId),
            (record) => this.#upsertExtension(record),
        );
    }

    disable(extensionId: string): Promise<ExtensionRuntimeRecord> {
        return this.#mutateExtensions(
            () => this.#runtime.disable(extensionId),
            (record) => this.#upsertExtension(record),
        );
    }

    reload(extensionId: string): Promise<ExtensionRuntimeRecord> {
        return this.#mutateExtensions(
            () => this.#runtime.reload(extensionId),
            (record) => this.#upsertExtension(record),
        );
    }

    remove(extensionId: string, purge = false): Promise<ExtensionRemoveResult> {
        return this.#mutateExtensions(
            () => this.#runtime.remove(extensionId, purge),
            (result) => this.#removeExtension(result.id),
        );
    }

    /** Reads one TUI page and caches its snapshot. */
    readTuiPage(pageId: string): Promise<TuiPageSnapshot> {
        return this.#readTuiPage(pageId, () => this.#tui.page(pageId));
    }

    /** Runs one TUI page action and caches the returned snapshot. */
    tuiAction(
        pageId: string,
        actionId: string,
        itemId?: string,
    ): Promise<TuiPageSnapshot> {
        return this.#readTuiPage(pageId, () =>
            this.#tui.action(pageId, actionId, itemId),
        );
    }

    /** Reads one Web page and caches its snapshot. */
    readWebPage(pageId: string): Promise<WebPageSnapshot> {
        return this.#readWebPage(pageId, () => this.#web.page(pageId));
    }

    /** Runs one Web page action and caches the returned snapshot. */
    webAction(
        pageId: string,
        actionId: string,
        rowId?: string,
    ): Promise<WebPageSnapshot> {
        return this.#readWebPage(pageId, () =>
            this.#web.action(pageId, actionId, rowId),
        );
    }

    close(): void {
        this.#epoch += 1;
        this.#subscription?.stop();
        this.#subscription = undefined;
        this.#refresh = undefined;
        this.#refreshDirty = false;
        this.#pendingRevision = 0;
        if (this.#refreshTimer !== undefined) clearTimeout(this.#refreshTimer);
        this.#refreshTimer = undefined;
        this.#versions.clear();
        this.#listeners.clear();
        this.#state = emptyState();
        this.#published = this.#state;
    }

    #startSubscription(epoch: number): void {
        if (this.#subscription !== undefined || epoch !== this.#epoch) return;
        this.#subscription = new EventSubscription<ExtensionChangeEvent>(this.#state.revision + 1, {
            open: (revision) => this.#runtime.subscribe(revision),
            eventSeq: (event) => event.revision,
            readGapError: readStreamGap,
            onEvent: (event) => {
                if (epoch !== this.#epoch || event.revision <= this.#state.revision) return;
                this.#pendingRevision = Math.max(this.#pendingRevision, event.revision);
                this.#refreshDirty = true;
                if (this.#refreshTimer !== undefined) return;
                this.#refreshTimer = setTimeout(() => {
                    this.#refreshTimer = undefined;
                    if (epoch !== this.#epoch || this.#pendingRevision <= this.#state.revision) return;
                    void this.refreshCatalogs();
                }, 100);
            },
            onGap: async (gap) => {
                this.#pendingRevision = Math.max(this.#pendingRevision, gap.lastSeq);
                this.#refreshDirty = true;
                const revision = await this.#refreshSnapshot(epoch);
                return revision === undefined ? undefined : revision + 1;
            },
        });
        this.#subscription.start();
    }

    #refreshSnapshot(epoch: number): Promise<number | undefined> {
        if (this.#refresh !== undefined) return this.#refresh;
        this.#refreshDirty = true;
        const refresh = this.#readSnapshots(epoch).finally(() => {
            if (this.#refresh === refresh) this.#refresh = undefined;
        });
        this.#refresh = refresh;
        return refresh;
    }

    async #readSnapshots(epoch: number): Promise<number | undefined> {
        while (this.#refreshDirty && epoch === this.#epoch) {
            this.#refreshDirty = false;
            const version = this.#nextVersion("snapshot");
            try {
                const snapshot = await this.#runtime.snapshot();
                if (epoch !== this.#epoch) return undefined;
                if (!this.#valid("snapshot", version, epoch)) {
                    this.#refreshDirty = true;
                    continue;
                }
                if (snapshot.revision < this.#state.revision) return undefined;
                const tuiPages = orderPages(snapshot.tuiPages);
                const webPages = orderPages(snapshot.webPages);
                this.#invalidateRemovedPages("tui:page:", tuiPages);
                this.#invalidateRemovedPages("web:page:", webPages);
                this.#state = {
                    ...this.#state,
                    revision: snapshot.revision,
                    extensions: orderExtensions(snapshot.extensions),
                    extensionsFailure: undefined,
                    tuiFailure: undefined,
                    tuiPages,
                    tuiSupported: snapshot.tuiSupported,
                    tuiSnapshots: pruneSnapshots(this.#state.tuiSnapshots, tuiPages),
                    webApplications: orderPages(snapshot.webApplications),
                    webFailure: undefined,
                    webPages,
                    webSupported: snapshot.webSupported,
                    webSnapshots: pruneSnapshots(this.#state.webSnapshots, webPages),
                };
                this.#refreshDirty = this.#pendingRevision > snapshot.revision;
                this.#emit();
            } catch (error) {
                if (epoch !== this.#epoch) return undefined;
                this.#state = { ...this.#state, extensionsFailure: toError(error) };
                this.#emit();
                return undefined;
            }
        }
        return epoch === this.#epoch ? this.#state.revision : undefined;
    }

    async #mutateExtensions<Result>(
        operation: () => Promise<Result>,
        apply: (result: Result) => void,
    ): Promise<Result> {
        const epoch = this.#epoch;
        this.#nextVersion("snapshot");
        try {
            const result = await operation();
            if (epoch !== this.#epoch) return result;
            this.#nextVersion("snapshot");
            apply(result);
            this.#state = { ...this.#state, extensionsFailure: undefined };
            this.#emit();
            return result;
        } catch (error) {
            if (epoch === this.#epoch) {
                this.#state = {
                    ...this.#state,
                    extensionsFailure: toError(error),
                };
                this.#emit();
            }
            throw error;
        }
    }

    async #readTuiPage(
        pageId: string,
        read: () => Promise<TuiPageSnapshot>,
    ): Promise<TuiPageSnapshot> {
        const epoch = this.#epoch;
        const key = `tui:page:${pageId}`;
        const version = this.#nextVersion(key);
        try {
            const snapshot = await read();
            if (!this.#valid(key, version, epoch)) return snapshot;
            this.#state = {
                ...this.#state,
                tuiFailure: undefined,
                tuiSnapshots: new Map(this.#state.tuiSnapshots).set(
                    pageId,
                    snapshot,
                ),
            };
            this.#emit();
            return snapshot;
        } catch (error) {
            if (this.#valid(key, version, epoch)) {
                this.#state = { ...this.#state, tuiFailure: toError(error) };
                this.#emit();
            }
            throw error;
        }
    }

    async #readWebPage(
        pageId: string,
        read: () => Promise<WebPageSnapshot>,
    ): Promise<WebPageSnapshot> {
        const epoch = this.#epoch;
        const key = `web:page:${pageId}`;
        const version = this.#nextVersion(key);
        try {
            const snapshot = await read();
            if (!this.#valid(key, version, epoch)) return snapshot;
            this.#state = {
                ...this.#state,
                webFailure: undefined,
                webSnapshots: new Map(this.#state.webSnapshots).set(
                    pageId,
                    snapshot,
                ),
            };
            this.#emit();
            return snapshot;
        } catch (error) {
            if (this.#valid(key, version, epoch)) {
                this.#state = { ...this.#state, webFailure: toError(error) };
                this.#emit();
            }
            throw error;
        }
    }

    #upsertExtension(record: ExtensionRuntimeRecord): void {
        const records = this.#state.extensions.filter(
            (current) => current.id !== record.id,
        );
        const { retired, ...publicRecord } = record;
        records.push(publicRecord);
        this.#state = {
            ...this.#state,
            extensions: orderExtensions(records),
        };
    }

    #removeExtension(extensionId: string): void {
        this.#state = {
            ...this.#state,
            extensions: this.#state.extensions.filter(
                (current) => current.id !== extensionId,
            ),
        };
    }

    #nextVersion(key: string): number {
        const version = (this.#versions.get(key) ?? 0) + 1;
        this.#versions.set(key, version);
        return version;
    }

    #invalidateRemovedPages(prefix: string, pages: readonly { id: string }[]): void {
        const ids = new Set(pages.map((page) => page.id));
        for (const key of this.#versions.keys()) {
            if (key.startsWith(prefix) && !ids.has(key.slice(prefix.length)))
                this.#nextVersion(key);
        }
    }

    #valid(key: string, version: number, epoch: number): boolean {
        return this.#epoch === epoch && this.#versions.get(key) === version;
    }

    #emit(): void {
        this.#published = this.#state;
        this.#state = { ...this.#published };
        for (const listener of this.#listeners) listener();
    }
}

function emptyState(): ExtensionViewModelState {
    return {
        revision: 0,
        extensions: [],
        tuiPages: [],
        tuiSnapshots: new Map(),
        tuiSupported: true,
        webApplications: [],
        webPages: [],
        webSnapshots: new Map(),
        webSupported: true,
    };
}

function orderExtensions(
    records: readonly ExtensionPublicRuntimeRecord[],
): ExtensionPublicRuntimeRecord[] {
    return [...records].sort((left, right) => left.id.localeCompare(right.id));
}

function orderPages<Descriptor extends { id: string; title: string }>(
    pages: readonly Descriptor[],
): Descriptor[] {
    return [...pages].sort(
        (left, right) =>
            left.title.localeCompare(right.title) ||
            left.id.localeCompare(right.id),
    );
}

function pruneSnapshots<Snapshot>(
    snapshots: ReadonlyMap<string, Snapshot>,
    pages: readonly { id: string }[],
): ReadonlyMap<string, Snapshot> {
    const ids = new Set(pages.map((page) => page.id));
    const pruned = new Map<string, Snapshot>();
    for (const [id, snapshot] of snapshots)
        if (ids.has(id)) pruned.set(id, snapshot);
    return pruned;
}


function toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}
