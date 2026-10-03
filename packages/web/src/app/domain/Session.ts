import {
    ApprovalViewModel,
    ArtifactViewModel,
    ConfigViewModel,
    ContextViewModel,
    ConversationViewModel,
    Endpoint,
    ExtensionViewModel,
    GoalViewModel,
    InstanceRegistryViewModel,
    McpViewModel,
    MessageViewModel,
    OverviewViewModel,
    RuntimeViewModel,
    ServiceSession,
    TodoViewModel,
    ToolCallViewModel,
    createApprovalTransport,
    createArtifactTransport,
    createConfigTransport,
    createContextTransport,
    createConversationTransport,
    createExtensionRuntimeTransport,
    createGoalTransport,
    createInstanceManagementTransport,
    createMcpControlTransport,
    createMessageTransport,
    createOverviewTransport,
    createReverseConnectionTransport,
    createRuntimeTransport,
    createServiceTransport,
    createTodoTransport,
    createToolTransport,
    createTuiPageTransport,
    createWebPageTransport,
    type Channel,
    type ReverseConnectionTransport,
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
    readonly conversation: ConversationViewModel;
    readonly extension: ExtensionViewModel;
    readonly goals: GoalViewModel;
    readonly instances: InstanceRegistryViewModel;
    readonly mcp: McpViewModel;
    readonly messages: MessageViewModel;
    readonly overview: OverviewViewModel;
    readonly reverse: ReverseConnectionTransport;
    readonly service: ServiceSession;
    readonly toolCalls: ToolCallViewModel;

    readonly #approvals = new Map<string, ApprovalViewModel>();
    readonly #endpoint: Endpoint;
    readonly #runtimes = new Map<string, RuntimeViewModel>();
    readonly #todos = new Map<string, TodoViewModel>();
    readonly #approvalTransport;
    readonly #runtimeTransport;
    readonly #todoTransport;

    constructor(options: WebDomainSessionOptions) {
        this.#endpoint = new Endpoint({ connectChannel: options.connectChannel });
        this.#runtimeTransport = createRuntimeTransport(this.#endpoint);
        this.#approvalTransport = createApprovalTransport(this.#endpoint);
        this.#todoTransport = createTodoTransport(this.#endpoint);
        const toolTransport = createToolTransport(this.#endpoint);

        this.service = new ServiceSession(
            this.#endpoint,
            createServiceTransport(this.#endpoint, { clientKind: "web" }),
        );
        this.config = new ConfigViewModel(createConfigTransport(this.#endpoint));
        this.overview = new OverviewViewModel(
            createOverviewTransport(this.#endpoint),
            { refreshIntervalMs: options.overviewRefreshIntervalMs },
        );
        this.mcp = new McpViewModel(createMcpControlTransport(this.#endpoint), {
            pollIntervalMs: options.mcpPollIntervalMs,
        });
        this.extension = new ExtensionViewModel(
            createExtensionRuntimeTransport(this.#endpoint),
            createTuiPageTransport(this.#endpoint),
            createWebPageTransport(this.#endpoint),
        );
        this.instances = new InstanceRegistryViewModel(
            createInstanceManagementTransport(this.#endpoint),
        );
        this.artifactTransport = createArtifactTransport(this.#endpoint);
        this.artifact = new ArtifactViewModel(this.artifactTransport);
        this.context = new ContextViewModel(createContextTransport(this.#endpoint));
        this.conversation = new ConversationViewModel({
            transport: createConversationTransport(
                this.#endpoint,
                this.#runtimeTransport,
            ),
        });
        this.messages = new MessageViewModel({
            transport: createMessageTransport(
                this.#endpoint,
                this.#runtimeTransport,
            ),
        });
        this.goals = new GoalViewModel({
            events: this.#runtimeTransport,
            transport: createGoalTransport(this.#endpoint),
        });
        this.toolCalls = new ToolCallViewModel({
            cursor: async (instance) =>
                (await this.#runtimeTransport.snapshot(instance)).lastSeq,
            events: this.#runtimeTransport,
            transport: toolTransport,
        });
        this.reverse = createReverseConnectionTransport(this.#endpoint);
    }

    runtime(instance: string): RuntimeViewModel {
        let viewModel = this.#runtimes.get(instance);
        if (viewModel === undefined) {
            viewModel = new RuntimeViewModel(this.#runtimeTransport);
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
            viewModel = new TodoViewModel(this.#todoTransport);
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
        await this.service.connect();
        await Promise.all([
            this.config.get(),
            this.instances.list(),
            this.context.load(),
            this.artifact.load(),
            this.overview.refresh(),
            this.mcp.load(),
            this.extension.refreshCatalogs(),
            this.conversation.load(),
        ]);
        this.overview.start();
        this.mcp.start();
    }

    async reconnect(): Promise<void> {
        await this.service.reconnect();
        await Promise.all([
            this.config.refresh(),
            this.instances.refresh(),
            this.context.refresh(),
            this.artifact.refresh(),
            this.overview.refresh(),
            this.mcp.refresh(),
            this.extension.refreshCatalogs(),
            this.conversation.refreshPreferences(),
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
        this.conversation.close();
        this.context.close();
        this.artifact.close();
        this.instances.close();
        this.extension.close();
        this.mcp.close();
        this.overview.close();
        this.config.close();
        this.service.close();
    }
}
