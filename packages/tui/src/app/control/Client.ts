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
    connectControlChannel,
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
    createTerminalTransport,
    createTodoTransport,
    createToolTransport,
    createTuiPageTransport,
    createWebPageTransport,
    type ApprovalTransport,
    type ArtifactTransport,
    type ConfigTransport,
    type ControlChannelOptions,
    type InstanceManagementTransport,
    type ReverseConnectionTransport,
    type RuntimeTransport,
    type ServiceTransport,
    type TerminalTransport,
    type TodoTransport,
    type ToolTransport,
} from "@portable-devshell/shared";

export interface TuiClientOptions extends ControlChannelOptions {}

/**
 * TUI-local domain container. It composes the explicit domain view models and
 * the domain transports they were built over on exactly one physical Endpoint.
 * It owns references and lifecycle only: it holds no aggregate snapshot and no
 * combined subscription surface.
 */
export class TuiDomainSession {
    readonly service: ServiceSession;
    readonly config: ConfigViewModel;
    readonly overview: OverviewViewModel;
    readonly mcp: McpViewModel;
    readonly extension: ExtensionViewModel;
    readonly instances: InstanceRegistryViewModel;
    readonly artifact: ArtifactViewModel;
    readonly context: ContextViewModel;
    readonly conversation: ConversationViewModel;
    readonly messages: MessageViewModel;
    readonly goals: GoalViewModel;
    readonly toolCalls: ToolCallViewModel;

    readonly artifactTransport: ArtifactTransport;
    readonly configTransport: ConfigTransport;
    readonly instanceTransport: InstanceManagementTransport;
    readonly reverse: ReverseConnectionTransport;
    readonly serviceTransport: ServiceTransport;
    readonly terminalTransport: TerminalTransport;
    readonly todoTransport: TodoTransport;
    readonly toolTransport: ToolTransport;

    readonly #approvals = new Map<string, ApprovalViewModel>();
    readonly #runtimes = new Map<string, RuntimeViewModel>();
    readonly #todos = new Map<string, TodoViewModel>();
    readonly #approvalTransport: ApprovalTransport;
    readonly #runtimeTransport: RuntimeTransport;

    constructor(options: TuiClientOptions = {}) {
        const endpoint = new Endpoint({
            connectChannel: (signal) => connectControlChannel(options, signal),
        });
        this.#runtimeTransport = createRuntimeTransport(endpoint);
        this.#approvalTransport = createApprovalTransport(endpoint);
        this.terminalTransport = createTerminalTransport(endpoint);

        this.serviceTransport = createServiceTransport(endpoint, {
            clientKind: "tui",
        });
        this.service = new ServiceSession(endpoint, this.serviceTransport);

        this.configTransport = createConfigTransport(endpoint);
        this.config = new ConfigViewModel(this.configTransport);
        this.overview = new OverviewViewModel(createOverviewTransport(endpoint));
        this.mcp = new McpViewModel(createMcpControlTransport(endpoint));
        this.extension = new ExtensionViewModel(
            createExtensionRuntimeTransport(endpoint),
            createTuiPageTransport(endpoint),
            createWebPageTransport(endpoint),
        );
        this.instanceTransport = createInstanceManagementTransport(endpoint);
        this.instances = new InstanceRegistryViewModel(this.instanceTransport);

        this.artifactTransport = createArtifactTransport(endpoint);
        this.artifact = new ArtifactViewModel(this.artifactTransport);
        this.context = new ContextViewModel(createContextTransport(endpoint));
        this.conversation = new ConversationViewModel({
            transport: createConversationTransport(
                endpoint,
                this.#runtimeTransport,
            ),
        });
        this.messages = new MessageViewModel({
            transport: createMessageTransport(
                endpoint,
                this.#runtimeTransport,
            ),
        });
        this.goals = new GoalViewModel({
            events: this.#runtimeTransport,
            transport: createGoalTransport(endpoint),
        });
        this.toolTransport = createToolTransport(endpoint);
        this.toolCalls = new ToolCallViewModel({
            cursor: async (instance) =>
                (await this.#runtimeTransport.snapshot(instance)).lastSeq,
            events: this.#runtimeTransport,
            transport: this.toolTransport,
        });
        this.todoTransport = createTodoTransport(endpoint);
        this.reverse = createReverseConnectionTransport(endpoint);
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
            viewModel = new TodoViewModel(this.todoTransport);
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
            this.config.refresh(),
            this.instances.refresh(),
            this.context.refresh(),
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

export function createTuiDomainSession(
    options: TuiClientOptions = {},
): TuiDomainSession {
    return new TuiDomainSession(options);
}
