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
    TodoViewModel,
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
    readonly #todos = new Map<string, TodoViewModel>();
    readonly #approvalTransport;
    readonly #messageTransport: MessageTransport;
    readonly #runtimeTransport;
    readonly #taskTransport;

    constructor(options: WebDomainSessionOptions) {
        this.#endpoint = new Endpoint({ connectChannel: options.connectChannel });
        this.#runtimeTransport = createProcessTransport(this.#endpoint);
        this.#approvalTransport = createApprovalTransport(this.#endpoint);
        this.#messageTransport = createMessageTransport(this.#endpoint);
        this.#taskTransport = createTaskTransport(this.#endpoint);
        const toolTransport = createToolTransport(this.#endpoint);

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
        this.goals = new GoalViewModel({ transport: this.#taskTransport });
        this.toolCalls = new ToolCallViewModel({
            cursor: async (instance) =>
                (await this.#runtimeTransport.snapshot(instance)).lastSeq,
            transport: toolTransport,
        });
        this.reverse = createConnectionTransport(this.#endpoint);
    }

    runtime(instance: string): ProcessViewModel {
        let viewModel = this.#runtimes.get(instance);
        if (viewModel === undefined) {
            viewModel = new ProcessViewModel(this.#runtimeTransport);
            this.#runtimes.set(instance, viewModel);
        }
        return viewModel;
    }

    approval(instance: string): ApprovalViewModel {
        let viewModel = this.#approvals.get(instance);
        if (viewModel === undefined) {
            viewModel = new ApprovalViewModel(this.#approvalTransport);
            this.#approvals.set(instance, viewModel);
        }
        return viewModel;
    }

    todo(instance: string): TodoViewModel {
        let viewModel = this.#todos.get(instance);
        if (viewModel === undefined) {
            viewModel = new TodoViewModel(this.#taskTransport);
            this.#todos.set(instance, viewModel);
        }
        return viewModel;
    }

    releaseInstance(instance: string): void {
        this.#runtimes.get(instance)?.close();
        this.#runtimes.delete(instance);
        this.#approvals.get(instance)?.close();
        this.#approvals.delete(instance);
        this.#todos.get(instance)?.close();
        this.#todos.delete(instance);
        this.goals.release(instance);
        this.toolCalls.release(instance);
    }

    async load(): Promise<void> {
        await this.server.connect();
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
        this.overview.start();
        this.mcp.start();
    }

    async reconnect(): Promise<void> {
        await this.server.reconnect();
        await Promise.all([
            this.config.refresh(),
            this.instances.refresh(),
            this.context.refresh(),
            this.artifact.refresh(),
            this.overview.refresh(),
            this.mcp.refresh(),
            this.extension.refreshCatalogs(),
            this.messagePreferences.refresh(),
        ]);
    }

    close(): void {
        for (const viewModel of this.#runtimes.values()) viewModel.close();
        for (const viewModel of this.#approvals.values()) viewModel.close();
        for (const viewModel of this.#todos.values()) viewModel.close();
        this.#runtimes.clear();
        this.#approvals.clear();
        this.#todos.clear();
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
