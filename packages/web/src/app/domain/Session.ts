import {
    ApprovalViewModel,
    ArtifactViewModel,
    ConfigViewModel,
    MessagePreferenceViewModel,
    ContextViewModel,
    MessageHistoryViewModel,
    Endpoint,
    ExtensionViewModel,
    GoalViewModel,
    InstanceConfigViewModel,
    AuthViewModel,
    MessageViewModel,
    OverviewViewModel,
    ProcessViewModel,
    ServerSession,
    ToolCallViewModel,
    createApprovalTransport,
    createArtifactTransport,
    createConfigTransport,
    createMessagePreferenceTransport,
    createInstanceTransport,
    createContextTransport,
    createExtensionRuntimeTransport,
    createTaskTransport,
    createAuthTransport,
    createMessageTransport,
    createOverviewTransport,
    createConnectionTransport,
    createProcessTransport,
    createServerTransport,
    createToolTransport,
    createTuiPageTransport,
    createWebPageTransport,
    type Channel,
    type ConnectionTransport,
    type MessageTransport,
} from "@portable-devshell/shared";

export type WebChannelConnector = (signal?: AbortSignal) => Promise<Channel>;

export interface WebDomainSessionOptions {
    connectChannel: WebChannelConnector;
    mcpPollIntervalMs?: number;
    overviewRefreshIntervalMs?: number;
}

export class WebDomainSession {
    readonly artifact: ArtifactViewModel;
    readonly artifactTransport;
    readonly config: ConfigViewModel;
    readonly context: ContextViewModel;
    readonly messageHistory: MessageHistoryViewModel;
    readonly messagePreferences: MessagePreferenceViewModel;
    readonly extension: ExtensionViewModel;
    readonly goals: GoalViewModel;
    readonly instances: InstanceConfigViewModel;
    readonly mcp: AuthViewModel;
    readonly messages: MessageViewModel;
    readonly overview: OverviewViewModel;
    readonly reverse: ConnectionTransport;
    readonly server: ServerSession;
    readonly toolCalls: ToolCallViewModel;

    readonly #approvals = new Map<string, ApprovalViewModel>();
    readonly #endpoint: Endpoint;
    readonly #runtimes = new Map<string, ProcessViewModel>();
    readonly #messageTransport: MessageTransport;
    readonly #unsubscribeInstances: () => void;
    #knownInstances?: Map<string, string | undefined>;
    #generation = 0;
    #closed = false;

    constructor(options: WebDomainSessionOptions) {
        this.#endpoint = new Endpoint({ connectChannel: options.connectChannel });
        this.#messageTransport = createMessageTransport(this.#endpoint);

        this.server = new ServerSession(
            this.#endpoint,
            createServerTransport(this.#endpoint, { clientKind: "web" }),
        );
        this.config = new ConfigViewModel(createConfigTransport(this.#endpoint));
        this.messagePreferences = new MessagePreferenceViewModel(
            createMessagePreferenceTransport(this.#endpoint),
        );
        this.overview = new OverviewViewModel(
            createOverviewTransport(this.#endpoint),
            { refreshIntervalMs: options.overviewRefreshIntervalMs },
        );
        this.mcp = new AuthViewModel(createAuthTransport(this.#endpoint), {
            pollIntervalMs: options.mcpPollIntervalMs,
        });
        this.extension = new ExtensionViewModel(
            createExtensionRuntimeTransport(this.#endpoint),
            createTuiPageTransport(this.#endpoint),
            createWebPageTransport(this.#endpoint),
        );
        this.instances = new InstanceConfigViewModel(
            createInstanceTransport(this.#endpoint),
        );
        this.artifactTransport = createArtifactTransport(this.#endpoint);
        this.artifact = new ArtifactViewModel(this.artifactTransport);
        this.context = new ContextViewModel(createContextTransport(this.#endpoint));
        this.messageHistory = new MessageHistoryViewModel({
            transport: this.#messageTransport,
        });
        this.messages = new MessageViewModel({
            transport: this.#messageTransport,
        });
        this.goals = new GoalViewModel({
            transport: (instance) =>
                createTaskTransport(this.#endpoint, instance),
        });
        this.toolCalls = new ToolCallViewModel({
            cursor: async (instance, signal) =>
                (
                    await createProcessTransport(
                        this.#endpoint,
                        instance,
                    ).snapshot(signal)
                ).lastSeq,
            transport: (instance) =>
                createToolTransport(this.#endpoint, instance),
        });
        this.reverse = createConnectionTransport(this.#endpoint);
        this.#unsubscribeInstances = this.instances.subscribe(() => {
            if (this.#closed) return;
            const state = this.instances.state;
            if (state.loading || state.refreshing || state.failure !== undefined || !state.supported) return;
            const current = new Map(state.instances.map(({ name, incarnation }) => [name, incarnation]));
            for (const [instance, incarnation] of this.#knownInstances ?? [])
                if (!current.has(instance) || current.get(instance) !== incarnation)
                    this.releaseInstance(instance);
            this.#knownInstances = current;
        });
    }

    runtime(instance: string): ProcessViewModel {
        let viewModel = this.#runtimes.get(instance);
        if (viewModel === undefined) {
            viewModel = new ProcessViewModel(
                createProcessTransport(this.#endpoint, instance),
            );
            this.#runtimes.set(instance, viewModel);
        }
        return viewModel;
    }

    approval(instance: string): ApprovalViewModel {
        let viewModel = this.#approvals.get(instance);
        if (viewModel === undefined) {
            viewModel = new ApprovalViewModel(
                createApprovalTransport(this.#endpoint, instance),
            );
            this.#approvals.set(instance, viewModel);
        }
        return viewModel;
    }

    releaseInstance(instance: string): void {
        this.#runtimes.get(instance)?.close();
        this.#runtimes.delete(instance);
        this.#approvals.get(instance)?.close();
        this.#approvals.delete(instance);
        this.goals.release(instance);
        this.toolCalls.release(instance);
        this.messages.release(instance);
        this.messageHistory.release(instance);
    }

    async load(): Promise<void> {
        if (this.#closed) return;
        const generation = ++this.#generation;
        await this.server.connect();
        if (this.#closed || generation !== this.#generation) return;
        await Promise.all([
            this.config.get(),
            this.instances.list(),
            this.context.load(),
            this.artifact.load(),
            this.overview.refresh(),
            this.mcp.load(),
            this.extension.refreshCatalogs(),
            this.messageHistory.load(),
            this.messagePreferences.refresh(),
        ]);
        if (this.#closed || generation !== this.#generation) return;
        this.overview.start();
        this.mcp.start();
    }

    async reconnect(): Promise<void> {
        if (this.#closed) return;
        const generation = ++this.#generation;
        await this.server.reconnect();
        if (this.#closed || generation !== this.#generation) return;
        await Promise.all([
            this.config.refresh(),
            this.instances.refresh(),
            this.context.load(),
            this.artifact.load(),
            this.overview.refresh(),
            this.mcp.refresh(),
            this.extension.refreshCatalogs(),
            this.messagePreferences.refresh(),
        ]);
        if (this.#closed || generation !== this.#generation) return;
        this.overview.start();
        this.mcp.start();
    }

    close(): void {
        if (this.#closed) return;
        this.#closed = true;
        this.#generation += 1;
        this.#unsubscribeInstances();
        for (const viewModel of this.#runtimes.values()) viewModel.close();
        for (const viewModel of this.#approvals.values()) viewModel.close();
        this.#runtimes.clear();
        this.#approvals.clear();
        this.goals.close();
        this.toolCalls.close();
        this.messages.close();
        this.messageHistory.close();
        this.messagePreferences.close();
        this.context.close();
        this.artifact.close();
        this.instances.close();
        this.extension.close();
        this.mcp.close();
        this.overview.close();
        this.config.close();
        this.server.close();
    }
}
