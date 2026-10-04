import {
    createEmptyConversationPreferences,
    type ApprovalRequest,
    type ConfigView,
    type ContextMessageRecord,
    type JsonValue,
    type McpContextRecord,
    type ToolCallRecord,
} from "@portable-devshell/shared";

import type { TuiDomainSession } from "../../src/app/control/Client.js";
import type { TuiRenderSource } from "../../src/app/Render.js";
import type { TuiInteractionProjection } from "../../src/interaction/Projection.js";
import { TuiDomainReader } from "../../src/view/domain/Reader.js";
import { createTuiViewProjection } from "../../src/view/projection/View.js";

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

export class TuiTestDomains {
    readonly service = new TestDomainSource({
        capabilities: [],
        status: "online" as const,
    });
    readonly config = new TestDomainSource({
        loading: false,
        refreshing: false,
        revision: 0,
        supported: true,
        view: undefined as any,
    });
    readonly overview = new TestDomainSource({
        overview: undefined as any,
        status: "idle" as "idle" | "ready",
    });
    readonly mcp = new TestDomainSource({
        approvals: [] as any[],
        status: undefined as any,
    });
    readonly extension = new TestDomainSource({
        extensions: [] as any[],
        tuiPages: [] as any[],
        tuiSnapshots: new Map<string, any>(),
        tuiSupported: true,
        webApplications: [] as any[],
        webPages: [] as any[],
        webSnapshots: new Map<string, any>(),
        webSupported: true,
    });
    readonly instances = new TestDomainSource({
        connection: "stopped" as const,
        instances: [] as any[],
        loading: false,
        refreshing: false,
        revision: 0,
        supported: true,
    });
    readonly artifact = new TestDomainSource({
        lastSeq: 0,
        shares: [] as any[],
        status: "stopped" as const,
        transfers: [] as any[],
    });
    readonly context = new TestDomainSource({
        contexts: [] as any[],
    });
    readonly conversation = new TestDomainSource({
        failures: {} as Record<string, Error>,
        instances: {} as Record<string, any>,
    });
    readonly conversationPreferences = new TestDomainSource({
        loading: false,
        preferences: createEmptyConversationPreferences(),
    });
    readonly messages = new TestDomainSource({
        failures: {} as Record<string, Error>,
        instances: {} as Record<string, any>,
    });
    readonly goals = new TestDomainSource({
        instances: {} as Record<string, any>,
    });
    readonly toolCalls = new TestDomainSource({
        instances: {} as Record<string, any>,
    });

    readonly #runtimes = new Map<string, TestDomainSource<any>>();
    readonly #approvals = new Map<string, TestDomainSource<any>>();
    readonly #todos = new Map<string, TestDomainSource<any>>();

    readonly domains: TuiDomainSession;
    readonly reader: TuiDomainReader;
    readonly projection: TuiInteractionProjection;

    constructor(
        attach: (source: TuiRenderSource) => () => void = () => () => undefined,
    ) {
        this.domains = {
            service: this.service,
            config: this.config,
            overview: this.overview,
            mcp: this.mcp,
            extension: this.extension,
            instances: this.instances,
            artifact: this.artifact,
            context: this.context,
            conversation: this.conversation,
            conversationPreferences: this.conversationPreferences,
            messages: this.messages,
            goals: this.goals,
            toolCalls: this.toolCalls,
            runtime: (instance: string) => this.runtime(instance),
            approval: (instance: string) => this.approval(instance),
            todo: (instance: string) => this.todo(instance),
        } as unknown as TuiDomainSession;
        this.reader = new TuiDomainReader(this.domains, attach);
        this.projection = createTuiViewProjection(this.reader);
    }

    runtime(instance: string): TestDomainSource<any> {
        return this.#source(this.#runtimes, instance, () => ({
            connection: "stopped",
            lastSeq: 0,
            logs: [],
            logsLoaded: false,
        }));
    }

    approval(instance: string): TestDomainSource<any> {
        return this.#source(this.#approvals, instance, () => ({
            approvals: [],
            lastSeq: 0,
            status: "stopped",
        }));
    }

    todo(instance: string): TestDomainSource<any> {
        return this.#source(this.#todos, instance, () => ({
            lastSeq: 0,
            status: "stopped",
        }));
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

    setGoals(instance: string, goals: readonly any[]): void {
        const current = this.goals.state.instances[instance] ?? {
            goals: [],
            lastSeq: 0,
            status: "stopped",
        };
        this.goals.patch({
            instances: {
                ...this.goals.state.instances,
                [instance]: { ...current, goals: [...goals] },
            },
        });
    }

    setConversation(instance: string, entries: readonly any[]): void {
        const current = this.conversation.state.instances[instance] ?? {
            entries: [],
            lastSeq: 0,
            status: "stopped",
        };
        this.conversation.patch({
            instances: {
                ...this.conversation.state.instances,
                [instance]: { ...current, entries: [...entries] },
            },
        });
    }

    setConversationPreferences(preferences: any): void {
        this.conversationPreferences.patch({ preferences });
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

    setExtension(input: {
        tuiPages?: readonly any[];
        tuiSnapshots?: ReadonlyMap<string, any>;
    }): void {
        this.extension.patch({
            ...(input.tuiPages === undefined
                ? {}
                : { tuiPages: [...input.tuiPages] }),
            ...(input.tuiSnapshots === undefined
                ? {}
                : { tuiSnapshots: new Map(input.tuiSnapshots) }),
        });
    }

    dispose(): void {
        this.reader.dispose();
    }

    #source(
        sources: Map<string, TestDomainSource<any>>,
        key: string,
        initial: () => any,
    ): TestDomainSource<any> {
        let source = sources.get(key);
        if (source === undefined) {
            source = new TestDomainSource(initial());
            sources.set(key, source);
        }
        return source;
    }
}

export interface TuiDomainHarnessOptions {
    approvalRecords?: ApprovalRequest[];
    configUpdate?: (request: unknown) => unknown;
    configView?: Record<string, unknown>;
    contextRecords?: McpContextRecord[];
    image?: {
        blake3: string;
        bytes: number;
        content: string;
        encoding: "base64";
        imageRef: string;
        mediaType: "image/gif" | "image/jpeg" | "image/png" | "image/webp";
        name: string;
        source: {
            handle?: string;
            instance: string;
            path?: string;
            type?: "artifact" | "directory" | "file";
        };
    };
    instanceList?: Array<{
        enabled: boolean;
        homeDirectory?: string;
        mcpEnabled: boolean;
        name: string;
        provider?: string;
        snapshot?: Record<string, unknown>;
    }>;
    pingError?: Error;
    toolCall?: (instance: string, toolName: string, input: unknown) => unknown;
    toolCallRecords?: ToolCallRecord[];
}

function readySnapshot(name: string): Record<string, unknown> {
    return {
        connectionState: "connected",
        daemonState: "running",
        lastSeq: 2,
        name,
        ready: true,
        status: "ready",
    };
}

/**
 * Full TUI domain fixture. It stands in for a `TuiDomainSession` so a real
 * `TuiRuntime` can be driven over deterministic domain state, mirroring the
 * web package's `WebTestDomains`. It records the transport calls the runtime
 * operations make and exposes the same accessors the CAS-era `createClients`
 * helper returned.
 */
export class TuiDomainHarness {
    readonly domains: TuiDomainSession;

    #closeCount = 0;
    #configUpdates: unknown[] = [];
    #createSchemaCalls = 0;
    #imageReads: Array<{ input: unknown; instance: string }> = [];
    #imageRefReads: string[] = [];
    #instanceList: NonNullable<TuiDomainHarnessOptions["instanceList"]>;
    #configView: Record<string, unknown>;
    #lifecycleActions: string[] = [];
    #refreshCount = 0;
    #toolCalls: Array<{
        input: unknown;
        instance: string;
        toolName: string;
    }> = [];
    readonly #approvalRecords: ApprovalRequest[];
    readonly #contextRecords: McpContextRecord[];
    readonly #options: TuiDomainHarnessOptions;
    readonly #toolCallRecords: ToolCallRecord[];
    readonly #instanceSource: TestDomainSource<any>;
    readonly #configSource: TestDomainSource<any>;
    readonly #runtimes = new Map<string, any>();
    readonly #approvals = new Map<string, any>();
    readonly #todos = new Map<string, any>();

    constructor(options: TuiDomainHarnessOptions = {}) {
        this.#options = options;
        this.#instanceList = options.instanceList ?? [];
        this.#configView = options.configView ?? { instances: [] };
        this.#approvalRecords = options.approvalRecords ?? [];
        this.#contextRecords = options.contextRecords ?? [];
        this.#toolCallRecords = options.toolCallRecords ?? [];
        const self = this;

        let runServiceHandshake!: (
            source: TestDomainSource<any>,
        ) => Promise<void>;
        const service = Object.assign(
            new TestDomainSource({
                capabilities: [] as any[],
                status: "online" as any,
            }),
            {
                close: () => undefined,
                connect: async () => {
                    await runServiceHandshake(service);
                },
                getSnapshot() {
                    return service.state;
                },
                reconnect: async () => {
                    await runServiceHandshake(service);
                },
                restart: async () => ({}) as Record<string, JsonValue>,
            },
        );
        const config = Object.assign(
            new TestDomainSource({
                loading: false,
                refreshing: false,
                revision: 0,
                supported: true,
                view: undefined as any,
            }),
            {
                close: () => undefined,
                get: async () => config.state.view,
                refresh: async () => {
                    config.patch({
                        view: self.#configView as unknown as ConfigView,
                    });
                    return self.#configView as unknown as ConfigView;
                },
                update: async (request: unknown) => {
                    self.#configUpdates.push(request);
                    return (self.#options.configUpdate?.(request) ??
                        {}) as ConfigView;
                },
                updateInstance: async (request: unknown) => {
                    self.#configUpdates.push(request);
                    return {} as ConfigView;
                },
                updateMcpEndpoint: async () => ({}) as ConfigView,
                updateWeb: async () => ({}) as ConfigView,
                validate: async () => ({}) as ConfigView,
            },
        );
        this.#configSource = config;
        const overview = Object.assign(
            new TestDomainSource({
                overview: undefined as any,
                status: "idle" as "idle" | "ready",
            }),
            {
                close: () => undefined,
                refresh: async () => undefined,
                start: () => undefined,
                stop: () => undefined,
            },
        );
        const mcp = Object.assign(
            new TestDomainSource({
                approvals: [] as any[],
                status: undefined as any,
            }),
            {
                close: () => undefined,
                decideApproval: async () => undefined,
                load: async () => undefined,
                refresh: async () => {
                    mcp.patch({
                        approvals: [...self.#approvalRecords],
                        status: { running: false } as any,
                    });
                },
                start: () => undefined,
                stop: () => undefined,
            },
        );
        const extension = Object.assign(
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
                close: () => undefined,
                readTuiPage: async () => ({ items: [], title: "" }),
                refreshCatalogs: async () => undefined,
                tuiAction: async () => ({ items: [], title: "" }),
            },
        );
        const instances = Object.assign(
            new TestDomainSource({
                connection: "stopped" as const,
                instances: [] as any[],
                loading: false,
                refreshing: false,
                revision: 0,
                supported: true,
            }),
            {
                close: () => undefined,
                refresh: async () => {
                    const list = self.#normalizedInstances();
                    instances.patch({ instances: list });
                    for (const entry of list) {
                        self.#loadRuntimeSnapshot(entry.name);
                    }
                },
            },
        );
        this.#instanceSource = instances;
        const artifact = Object.assign(
            new TestDomainSource({
                lastSeq: 0,
                shares: [] as any[],
                status: "stopped" as const,
                transfers: [] as any[],
            }),
            {
                close: () => undefined,
                load: async () => undefined,
                refresh: async () => undefined,
            },
        );
        const context = Object.assign(
            new TestDomainSource({ contexts: [] as any[] }),
            {
                close: () => undefined,
                disable: async (ctxId: string) => ({ ctxId }),
                refresh: async () => {
                    context.patch({ contexts: [...self.#contextRecords] });
                },
                renew: async (ctxId: string) => ({ ctxId }),
            },
        );
        const conversation = Object.assign(
            new TestDomainSource({
                failures: {} as Record<string, Error>,
                instances: {} as Record<string, any>,
            }),
            {
                close: () => undefined,
                load: async () => undefined,
                refreshInstance: async () => 0,
            },
        );
        const conversationPreferences = Object.assign(
            new TestDomainSource({
                loading: false,
                preferences: createEmptyConversationPreferences(),
            }),
            {
                close: () => undefined,
                refresh: async () => conversationPreferences.state.preferences,
                update: async (patch: Record<string, unknown>) => {
                    const next = {
                        ...conversationPreferences.state.preferences,
                        ...patch,
                    };
                    conversationPreferences.patch({ preferences: next as any });
                    return next;
                },
            },
        );
        const messages = Object.assign(
            new TestDomainSource({
                failures: {} as Record<string, Error>,
                instances: {} as Record<string, any>,
            }),
            {
                close: () => undefined,
                load: async () => undefined,
                queue: async (instance: string, ctxId: string, text: string) =>
                    ({
                        createdAt: new Date(0).toISOString(),
                        ctxId,
                        id: "queued",
                        instance,
                        status: "pending",
                        text,
                    }) as ContextMessageRecord,
                refreshInstance: async () => 0,
            },
        );
        const goals = Object.assign(
            new TestDomainSource({ instances: {} as Record<string, any> }),
            {
                close: () => undefined,
                load: async () => undefined,
                release: () => undefined,
            },
        );
        const toolCalls = Object.assign(
            new TestDomainSource({ instances: {} as Record<string, any> }),
            {
                close: () => undefined,
                load: async (instance: string) => {
                    toolCalls.patch({
                        instances: {
                            ...toolCalls.state.instances,
                            [instance]: {
                                calls: [...self.#toolCallRecords],
                                lastSeq: 2,
                                status: "stopped",
                            },
                        },
                    });
                },
                readDetail: async (instance: string, callId: string) =>
                    self.#toolCallRecords.filter(
                        (call) =>
                            call.instance === instance &&
                            call.callId === callId,
                    ),
                release: () => undefined,
            },
        );

        const artifactTransport = {
            cancelTransfer: async () => ({}) as any,
            createShare: async () => ({}) as any,
            getTransfer: async () => ({}) as any,
            readImage: async (imageRef: string) => {
                self.#imageRefReads.push(imageRef);
                if (self.#options.image === undefined) {
                    throw new Error("No image fixture configured.");
                }
                const {
                    name: _name,
                    source: _source,
                    ...stored
                } = self.#options.image;
                return stored;
            },
            revokeShare: async () => ({}) as any,
            snapshot: async () => ({}) as any,
            startTransfer: async () => ({}) as any,
            subscribe: async () => {
                throw new Error("Artifact subscription is not supported.");
            },
            viewImage: async (instance: string, input: unknown) => {
                self.#imageReads.push({ input, instance });
                if (self.#options.image === undefined) {
                    throw new Error("No image fixture configured.");
                }
                return self.#options.image;
            },
        };
        const instanceTransport = {
            createInstance: async (draft: { name: string }) =>
                ({
                    enabled: true,
                    name: draft.name,
                }) as any,
            createInstanceSchema: async () => {
                self.#createSchemaCalls += 1;
                return {
                    container: {
                        defaultMode: "preset" as const,
                        modes: [
                            "preset",
                            "dockerfile",
                            "compose",
                            "existingImage",
                            "existingStoppedContainer",
                        ] as const,
                        presets: [],
                    },
                    defaultEnabled: true,
                    defaultMcpEnabled: true,
                    defaultModelExtensions: ["instance"],
                    defaultProvider: "local" as const,
                    defaultSecurityMode: "disabled" as const,
                    providers: ["local", "ssh", "docker", "podman"] as const,
                };
            },
            deleteInstance: async () => ({}) as Record<string, JsonValue>,
            disableInstance: async () => ({}) as Record<string, JsonValue>,
            enableInstance: async () => ({}) as Record<string, JsonValue>,
            listInstances: async () => self.#normalizedInstances(),
            snapshotInstances: async () => ({
                instances: self.#normalizedInstances(),
                revision: 0,
            }),
            subscribeInstances: async () => {
                throw new Error("Instance subscription is not supported.");
            },
            updateInstance: config.updateInstance,
            validateInstanceCreate: async (draft: {
                name: string;
                provider: string;
            }) =>
                ({
                    enabled: true,
                    extensions: { model: ["instance"] },
                    mcp: {
                        auth: { mode: "none" as const },
                        enabled: false,
                        path: `/${draft.name}/mcp`,
                    },
                    name: draft.name,
                    provider: draft.provider,
                    security: { mode: "disabled" as const },
                }) as any,
        };
        const configTransport = {
            get: async () => self.#configView as unknown as ConfigView,
            getConversationPreferences: async () =>
                conversationPreferences.state.preferences,
            snapshot: async () =>
                ({
                    revision: 0,
                    view: self.#configView,
                }) as any,
            subscribe: async () => {
                throw new Error("Config subscription is not supported.");
            },
            update: config.update,
            updateConversationPreferences: async (
                patch: Record<string, unknown>,
            ) => await conversationPreferences.update(patch),
            updateMcpEndpoint: config.updateMcpEndpoint,
            updateWeb: config.updateWeb,
            validate: config.validate,
        };
        const reverse = {
            createCode: async (instance: string) => ({
                controllerUrl: "https://example.test",
                deviceCode: "device-code",
                expiresAt: "2026-07-17T00:00:00.000Z",
                instance,
            }),
            revokeToken: async () => undefined,
            rotateToken: async (instance: string) => ({ instance }),
        };
        const serviceTransport = {
            hello: async () => ({
                capabilities: ["request", "stream", "streamResume"],
                protocolVersion: "1.0.0",
            }),
            ping: async () => {
                if (self.#options.pingError !== undefined) {
                    throw self.#options.pingError;
                }
                return { pong: true };
            },
            restart: async () => ({}) as Record<string, JsonValue>,
            status: async () => ({ running: true }) as any,
        };
        runServiceHandshake = async (source) => {
            source.patch({
                capabilities: [],
                failure: undefined,
                status: "connecting",
            } as any);
            try {
                const hello = await serviceTransport.hello();
                await serviceTransport.status();
                await serviceTransport.ping();
                source.patch({
                    capabilities: [...hello.capabilities],
                    failure: undefined,
                    status: "online",
                } as any);
            } catch (error) {
                source.patch({ failure: error, status: "offline" } as any);
                throw error;
            }
        };
        const taskTransport = {
            deleteTodo: async () => ({}) as Record<string, never>,
            getGoals: async () => ({ goals: [], lastSeq: 1 }),
            getTodo: async () =>
                ({
                    lastSeq: 1,
                    todo: {
                        items: [],
                        revision: 0,
                        summary: { completed: 0, total: 0 },
                        taskId: "task-1",
                        title: "Todo",
                    },
                }) as any,
            subscribe: async () => {
                throw new Error("Task subscription is not supported.");
            },
        };
        const toolTransport = {
            call: async (
                instance: string,
                toolName: string,
                input: JsonValue,
                _workspace: string,
            ) => {
                self.#toolCalls.push({ input, instance, toolName });
                return (self.#options.toolCall?.(instance, toolName, input) ??
                    {}) as JsonValue;
            },
            callStreaming: async (
                instance: string,
                toolName: string,
                input: JsonValue,
            ) =>
                (self.#options.toolCall?.(instance, toolName, input) ??
                    {}) as JsonValue,
            closeSession: async () => ({}) as Record<string, never>,
            listCalls: async () => [...self.#toolCallRecords],
            openSession: async () => ({}) as any,
        };
        const terminalTransport = {} as any;

        this.domains = {
            service,
            config,
            overview,
            mcp,
            extension,
            instances,
            artifact,
            artifactTransport,
            configTransport,
            instanceTransport,
            serviceTransport,
            taskTransport,
            terminalTransport,
            toolTransport,
            reverse,
            context,
            conversation,
            conversationPreferences,
            messages,
            goals,
            toolCalls,
            runtime: (instance: string) => this.runtime(instance),
            approval: (instance: string) => this.approval(instance),
            todo: (instance: string) => this.todo(instance),
            releaseInstance: (instance: string) => {
                this.#runtimes.delete(instance);
                this.#approvals.delete(instance);
                this.#todos.delete(instance);
            },
            load: async () => {
                await service.connect();
                await Promise.all([
                    config.refresh(),
                    instances.refresh(),
                    context.refresh(),
                    artifact.load(),
                    overview.refresh(),
                    mcp.load(),
                    extension.refreshCatalogs(),
                    conversation.load(),
                    conversationPreferences.refresh(),
                ]);
                overview.start();
                mcp.start();
            },
            reconnect: async () => {
                await service.reconnect();
                await Promise.all([
                    config.refresh(),
                    instances.refresh(),
                    context.refresh(),
                    artifact.refresh(),
                    overview.refresh(),
                    mcp.refresh(),
                    extension.refreshCatalogs(),
                    conversationPreferences.refresh(),
                ]);
            },
            close: () => {
                this.#closeCount += 1;
            },
        } as unknown as TuiDomainSession;
    }

    get value(): TuiDomainSession {
        return this.domains;
    }

    runtime(instance: string): any {
        let source = this.#runtimes.get(instance);
        if (source !== undefined) return source;
        const self = this;
        source = Object.assign(
            new TestDomainSource({
                connection: "stopped",
                lastSeq: 0,
                logs: [] as any[],
                logsLoaded: false,
                snapshot: undefined as any,
            }),
            {
                close: () => undefined,
                load: async () => {
                    self.#refreshCount += 1;
                    source.patch({
                        connection: "stopped",
                        snapshot: self.#runtimeSnapshot(instance),
                    });
                },
                readLogs: async () => source.state.logs,
                refresh: async () => {
                    self.#refreshCount += 1;
                    const snapshot = self.#runtimeSnapshot(instance);
                    source.patch({ snapshot });
                    return { lastSeq: snapshot.lastSeq, snapshot };
                },
                start: async () => {
                    self.#lifecycleActions.push(`start:${instance}`);
                    const snapshot = {
                        ...readySnapshot(instance),
                        lastSeq: 4,
                    };
                    source.patch({ snapshot });
                    return snapshot;
                },
                stop: async () => {
                    self.#lifecycleActions.push(`stop:${instance}`);
                    const snapshot = {
                        ...readySnapshot(instance),
                        connectionState: "disconnected",
                        daemonState: "stopped",
                        lastSeq: 3,
                        ready: false,
                        status: "stopped",
                    };
                    source.patch({ snapshot });
                    return snapshot;
                },
            },
        );
        this.#runtimes.set(instance, source);
        return source;
    }

    approval(instance: string): any {
        let source = this.#approvals.get(instance);
        if (source !== undefined) return source;
        const self = this;
        source = Object.assign(
            new TestDomainSource({
                approvals: [] as any[],
                lastSeq: 0,
                status: "stopped",
            }),
            {
                close: () => undefined,
                decide: async (approvalId: string, decision: string) =>
                    ({
                        approvalId,
                        decision,
                        instance,
                    }) as any,
                load: async () => {
                    source.patch({
                        approvals: [...self.#approvalRecords],
                        lastSeq: 2,
                    });
                },
                refresh: async () => undefined,
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
                close: () => undefined,
                delete: async () => undefined,
                load: async () => {
                    source.patch({
                        lastSeq: 1,
                        todo: {
                            items: [],
                            revision: 0,
                            summary: { completed: 0, total: 0 },
                            taskId: "task-1",
                            title: "Todo",
                        },
                    });
                },
                refresh: async () => undefined,
            },
        );
        this.#todos.set(instance, source);
        return source;
    }

    setControlState(
        nextInstances: NonNullable<TuiDomainHarnessOptions["instanceList"]>,
        nextConfigView: Record<string, unknown>,
    ): void {
        this.#instanceList = nextInstances;
        this.#configView = nextConfigView;
        const list = this.#normalizedInstances();
        this.#instanceSource.patch({ instances: list });
        this.#configSource.patch({
            view: nextConfigView as unknown as ConfigView,
        });
        for (const entry of list) {
            this.#loadRuntimeSnapshot(entry.name);
        }
    }

    closed(): number {
        return this.#closeCount;
    }

    configUpdates(): unknown[] {
        return this.#configUpdates;
    }

    createSchemaCalls(): number {
        return this.#createSchemaCalls;
    }

    imageRefReads(): string[] {
        return this.#imageRefReads;
    }

    imageReads(): Array<{ input: unknown; instance: string }> {
        return this.#imageReads;
    }

    lifecycleActions(): string[] {
        return this.#lifecycleActions;
    }

    refreshCalls(): number {
        return this.#refreshCount;
    }

    toolCalls(): Array<{
        input: unknown;
        instance: string;
        toolName: string;
    }> {
        return this.#toolCalls;
    }

    #loadRuntimeSnapshot(instance: string): void {
        this.runtime(instance).patch({
            connection: "stopped",
            snapshot: this.#runtimeSnapshot(instance),
        });
    }

    #normalizedInstances(): any[] {
        return this.#instanceList.map((instance) => ({
            ...instance,
            snapshot: instance.snapshot ?? readySnapshot(instance.name),
        }));
    }

    #runtimeSnapshot(instance: string): Record<string, unknown> & {
        lastSeq: number;
    } {
        const entry = this.#instanceList.find(
            (candidate) => candidate.name === instance,
        );
        return (entry?.snapshot ?? readySnapshot(instance)) as Record<
            string,
            unknown
        > & { lastSeq: number };
    }
}
