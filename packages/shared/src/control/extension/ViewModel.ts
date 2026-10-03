// Stateful extension control projection. Owns the installed runtime catalog,
// the optional TUI page catalog with its per-page snapshot cache, and the
// optional Web application/page catalogs with their per-page snapshot caches.
// Extension mutations and page reads/actions update only this extension state;
// the projection never reaches into another control domain.
//
// Catalog reads are explicit (refreshCatalogs) and page snapshots are updated
// only by an explicit read or action, so there is no polling. Read and mutation
// requests share one monotonic version per catalog and per page, so a slow
// response can never overwrite a newer projection; close() bumps the epoch and
// invalidates every in-flight request.
//
// A method-not-found `tui.pages`, `web.applications`, or `web.pages` means the
// control server does not expose that optional catalog at all. That is modelled
// explicitly as `tuiSupported`/`webSupported: false` with empty descriptors and
// no snapshots, rather than as a permanent failure; any other error stays in
// the catalog's domain-local failure.

import type {
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

export interface ExtensionViewModelState {
    extensions: ExtensionRuntimeRecord[];
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
        await Promise.all([
            this.#refreshExtensions(epoch),
            this.#refreshTuiPages(epoch),
            this.#refreshWebCatalog(epoch),
        ]);
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
        this.#versions.clear();
        this.#listeners.clear();
        this.#state = emptyState();
        this.#published = this.#state;
    }

    async #refreshExtensions(epoch: number): Promise<void> {
        const version = this.#nextVersion("extensions");
        try {
            const records = await this.#runtime.list();
            if (!this.#valid("extensions", version, epoch)) return;
            this.#state = {
                ...this.#state,
                extensions: orderExtensions(records),
                extensionsFailure: undefined,
            };
            this.#emit();
        } catch (error) {
            if (!this.#valid("extensions", version, epoch)) return;
            this.#state = {
                ...this.#state,
                extensionsFailure: toError(error),
            };
            this.#emit();
        }
    }

    async #refreshTuiPages(epoch: number): Promise<void> {
        const version = this.#nextVersion("tui");
        try {
            const pages = await this.#tui.pages();
            if (!this.#valid("tui", version, epoch)) return;
            const ordered = orderPages(pages);
            this.#state = {
                ...this.#state,
                tuiFailure: undefined,
                tuiPages: ordered,
                tuiSnapshots: pruneSnapshots(this.#state.tuiSnapshots, ordered),
                tuiSupported: true,
            };
            this.#emit();
        } catch (error) {
            if (!this.#valid("tui", version, epoch)) return;
            this.#state = isMethodNotFound(error)
                ? {
                      ...this.#state,
                      tuiFailure: undefined,
                      tuiPages: [],
                      tuiSnapshots: new Map(),
                      tuiSupported: false,
                  }
                : { ...this.#state, tuiFailure: toError(error) };
            this.#emit();
        }
    }

    async #refreshWebCatalog(epoch: number): Promise<void> {
        const version = this.#nextVersion("web");
        try {
            const [applications, pages] = await Promise.all([
                this.#web.applications(),
                this.#web.pages(),
            ]);
            if (!this.#valid("web", version, epoch)) return;
            const orderedPages = orderPages(pages);
            this.#state = {
                ...this.#state,
                webApplications: orderPages(applications),
                webFailure: undefined,
                webPages: orderedPages,
                webSnapshots: pruneSnapshots(
                    this.#state.webSnapshots,
                    orderedPages,
                ),
                webSupported: true,
            };
            this.#emit();
        } catch (error) {
            if (!this.#valid("web", version, epoch)) return;
            this.#state = isMethodNotFound(error)
                ? {
                      ...this.#state,
                      webApplications: [],
                      webFailure: undefined,
                      webPages: [],
                      webSnapshots: new Map(),
                      webSupported: false,
                  }
                : { ...this.#state, webFailure: toError(error) };
            this.#emit();
        }
    }

    async #mutateExtensions<Result>(
        operation: () => Promise<Result>,
        apply: (result: Result) => void,
    ): Promise<Result> {
        const epoch = this.#epoch;
        // Invalidate extension reads that started before this mutation so a
        // slow catalog response cannot roll the mutation back.
        this.#nextVersion("extensions");
        try {
            const result = await operation();
            if (epoch !== this.#epoch) return result;
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
        records.push(record);
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
    records: readonly ExtensionRuntimeRecord[],
): ExtensionRuntimeRecord[] {
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
