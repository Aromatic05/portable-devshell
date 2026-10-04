import { type ReactNode } from "react";
import { createEmptyMessagePreferences, type ArtifactStoredImageResult } from "@portable-devshell/shared";
import { type ServerSessionStatus } from "@portable-devshell/shared/testing";

import { WebDomainProvider } from "../../src/app/domain/Context.js";
import type { WebDomainSession } from "../../src/app/domain/Session.js";

export class TestDomainSource<State extends object> {
    readonly #listeners = new Set<() => void>();
    state: State;

    constructor(state: State) {
        this.state = state;
    }

    set(state: State): void {
        this.state = state;
        this.#emit();
    }

    patch(patch: Partial<State>): void {
        this.state = { ...this.state, ...patch };
        this.#emit();
    }

    subscribe(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    #emit(): void {
        for (const listener of this.#listeners) listener();
    }
}

function asyncVoid(): Promise<void> {
    return Promise.resolve();
}

export class WebTestDomains {
    readonly server = Object.assign(
        new TestDomainSource({
            capabilities: [] as any[],
            status: "online" as ServerSessionStatus,
        }),
        { restart: async () => ({}) },
    );
    readonly config = Object.assign(
        new TestDomainSource({
            loading: false,
            refreshing: false,
            revision: 0,
            supported: true,
            view: undefined as any,
        }),
        {
            get: asyncVoid,
            refresh: asyncVoid,
            update: async (request: any) => request,
            validate: asyncVoid,
        },
    );
    readonly overview = Object.assign(
        new TestDomainSource({
            overview: undefined as any,
            status: "idle" as "idle" | "ready",
        }),
        {
            refresh: asyncVoid,
            scheduleRefresh: (_delay?: number) => undefined,
            start: () => undefined,
            stop: () => undefined,
        },
    );
    readonly mcp = Object.assign(
        new TestDomainSource({
            approvals: [] as any[],
            status: undefined as any,
        }),
        {
            decideApproval: asyncVoid,
            refresh: asyncVoid,
        },
    );
    readonly extension = Object.assign(
        new TestDomainSource({
            extensions: [] as any[],
            tuiPages: [] as any[],
            tuiSnapshots: new Map<string, any>(),
            tuiSupported: true,
            webApplications: [] as any[],
            webPages: [] as any[],
            webSnapshots: new Map<string, any>(),
            webSupported: true,
        }),
        {
            readWebPage: async (_pageId: string) => ({ items: [] }),
            webAction: async (
                _pageId: string,
                _actionId: string,
                _rowId?: string,
            ) => ({ items: [] }),
        },
    );
    readonly instances = Object.assign(
        new TestDomainSource({
            connection: "stopped" as const,
            instances: [] as any[],
            loading: false,
            refreshing: false,
            revision: 0,
            supported: true,
        }),
        {
            create: async (draft: any) => ({ instance: draft.name }),
            createSchema: async () => ({}),
            delete: asyncVoid,
            disable: asyncVoid,
            enable: asyncVoid,
            refresh: asyncVoid,
            validateCreate: async (draft: any) => ({ draft }),
        },
    );
    readonly artifact = Object.assign(
        new TestDomainSource({
            lastSeq: 0,
            shares: [] as any[],
            status: "stopped" as const,
            transfers: [] as any[],
        }),
        {
            cancelTransfer: asyncVoid,
            refresh: asyncVoid,
            revokeShare: asyncVoid,
        },
    );
    readonly artifactTransport = {
        readImage: async (
            _imageRef: string,
        ): Promise<ArtifactStoredImageResult | undefined> => undefined,
    };
    readonly context = Object.assign(
        new TestDomainSource({
            contexts: [] as any[],
        }),
        {
            disable: async (ctxId: string) => ({ ctxId }),
            refresh: asyncVoid,
            renew: async (ctxId: string) => ({ ctxId }),
        },
    );
    readonly messageHistory = Object.assign(
        new TestDomainSource({
            failures: {} as Record<string, Error>,
            instances: {} as Record<string, any>,
        }),
        {
            load: asyncVoid,
            refreshInstance: async (_instance: string) => 0,
        },
    );
    readonly messagePreferences = Object.assign(
        new TestDomainSource({
            failure: undefined as Error | undefined,
            loading: false,
            preferences: createEmptyMessagePreferences(),
        }),
        {
            refresh: async () => this.messagePreferences.state.preferences,
            update: async (patch: any) => {
                const next = {
                    ...this.messagePreferences.state.preferences,
                    ...patch,
                };
                this.messagePreferences.patch({ preferences: next });
                return next;
            },
        },
    );
    readonly messages = Object.assign(
        new TestDomainSource({
            failures: {} as Record<string, Error>,
            instances: {} as Record<string, any>,
        }),
        {
            load: asyncVoid,
            queue: async (instance: string, ctxId: string, text: string) => ({
                createdAt: new Date(0).toISOString(),
                ctxId,
                id: "queued",
                instance,
                status: "pending",
                text,
            }),
            refreshInstance: async (_instance: string) => 0,
        },
    );
    readonly goals = new TestDomainSource({
        instances: {} as Record<string, any>,
    });
    readonly toolCalls = Object.assign(
        new TestDomainSource({
            instances: {} as Record<string, any>,
        }),
        {
            load: asyncVoid,
            readDetail: async (_instance: string, _callId: string) =>
                [] as any[],
        },
    );
    readonly reverse = {
        createCode: async (_instance: string) => ({}),
        revokeToken: asyncVoid,
        rotateToken: async (_instance: string) => ({}),
    };

    readonly #runtimes = new Map<string, any>();
    readonly #approvals = new Map<string, any>();
    readonly #todos = new Map<string, any>();

    readonly domains: WebDomainSession;

    constructor() {
        this.domains = {
            server: this.server,
            config: this.config,
            overview: this.overview,
            mcp: this.mcp,
            extension: this.extension,
            instances: this.instances,
            artifact: this.artifact,
            artifactTransport: this.artifactTransport,
            context: this.context,
            messageHistory: this.messageHistory,
            messagePreferences: this.messagePreferences,
            messages: this.messages,
            goals: this.goals,
            toolCalls: this.toolCalls,
            reverse: this.reverse,
            runtime: (instance: string) => this.runtime(instance),
            approval: (instance: string) => this.approval(instance),
            todo: (instance: string) => this.todo(instance),
            releaseInstance: (instance: string) => {
                this.#runtimes.delete(instance);
                this.#approvals.delete(instance);
                this.#todos.delete(instance);
            },
            load: asyncVoid,
            reconnect: asyncVoid,
            close: () => undefined,
        } as unknown as WebDomainSession;
    }

    runtime(instance: string): any {
        let source = this.#runtimes.get(instance);
        if (source !== undefined) return source;
        source = Object.assign(
            new TestDomainSource({
                connection: "stopped",
                lastSeq: 0,
                logs: [] as any[],
                logsLoaded: false,
                snapshot: undefined as any,
            }),
            {
                load: asyncVoid,
                readLogs: async () => source.state.logs,
                start: async () => source.state.snapshot,
                stop: async () => source.state.snapshot,
            },
        );
        this.#runtimes.set(instance, source);
        return source;
    }

    approval(instance: string): any {
        let source = this.#approvals.get(instance);
        if (source !== undefined) return source;
        source = Object.assign(
            new TestDomainSource({
                approvals: [] as any[],
                lastSeq: 0,
                status: "stopped",
            }),
            {
                decide: async (_approvalId: string, _decision: string) => ({}),
                load: asyncVoid,
            },
        );
        this.#approvals.set(instance, source);
        return source;
    }

    todo(instance: string): any {
        let source = this.#todos.get(instance);
        if (source !== undefined) return source;
        source = Object.assign(
            new TestDomainSource({
                lastSeq: 0,
                status: "stopped",
                todo: undefined as any,
            }),
            {
                delete: asyncVoid,
                load: asyncVoid,
                refresh: asyncVoid,
            },
        );
        this.#todos.set(instance, source);
        return source;
    }

    setInstances(instances: readonly any[]): void {
        this.instances.patch({ instances: [...instances] });
    }

    setRuntime(instance: string, patch: Record<string, unknown>): void {
        this.runtime(instance).patch(patch);
    }

    setApprovals(instance: string, approvals: readonly any[]): void {
        this.approval(instance).patch({ approvals: [...approvals] });
    }

    setTodo(instance: string, todo: any): void {
        this.todo(instance).patch({ todo });
    }

    setToolCalls(instance: string, calls: readonly any[]): void {
        const current = this.toolCalls.state.instances[instance] ?? {
            calls: [],
            lastSeq: 0,
            status: "stopped",
        };
        this.toolCalls.patch({
            instances: {
                ...this.toolCalls.state.instances,
                [instance]: { ...current, calls: [...calls] },
            },
        });
    }

    setMessageHistory(instance: string, entries: readonly any[]): void {
        const current = this.messageHistory.state.instances[instance] ?? {
            entries: [],
            lastSeq: 0,
            status: "stopped",
        };
        this.messageHistory.patch({
            instances: {
                ...this.messageHistory.state.instances,
                [instance]: { ...current, entries: [...entries] },
            },
        });
    }

    setMessages(instance: string, messages: readonly any[]): void {
        const current = this.messages.state.instances[instance] ?? {
            lastSeq: 0,
            messages: [],
            status: "stopped",
        };
        this.messages.patch({
            instances: {
                ...this.messages.state.instances,
                [instance]: { ...current, messages: [...messages] },
            },
        });
    }

    setContexts(contexts: readonly any[]): void {
        this.context.patch({ contexts: [...contexts] });
    }

    setConfig(view: any): void {
        this.config.patch({ view });
    }

    setOverview(overview: any): void {
        this.overview.patch({
            overview,
            status: overview === undefined ? "idle" : "ready",
        });
    }

    setMcp(input: { approvals?: readonly any[]; status?: any }): void {
        this.mcp.patch({
            ...(input.approvals === undefined
                ? {}
                : { approvals: [...input.approvals] }),
            ...(input.status === undefined ? {} : { status: input.status }),
        });
    }

    setArtifacts(input: {
        shares?: readonly any[];
        transfers?: readonly any[];
    }): void {
        this.artifact.patch({
            ...(input.shares === undefined
                ? {}
                : { shares: [...input.shares] }),
            ...(input.transfers === undefined
                ? {}
                : { transfers: [...input.transfers] }),
        });
    }
}

export function withWebDomains(
    domains: WebTestDomains,
    children: ReactNode,
): ReactNode {
    return (
        <WebDomainProvider domains={domains.domains}>
            {children}
        </WebDomainProvider>
    );
}
