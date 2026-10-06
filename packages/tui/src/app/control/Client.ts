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
    connectControlChannel,
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
    createTerminalTransport,
    createToolTransport,
    createTuiPageTransport,
    createWebPageTransport,
    type ApprovalTransport,
    type ArtifactTransport,
    type ConfigTransport,
    type InstanceTransport,
    type ControlChannelOptions,
    type MessageTransport,
    type ConnectionTransport,
    type ProcessTransport,
    type ServerTransport,
    type TerminalTransport,
    type TaskTransport,
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
    readonly server: ServerSession;
    readonly config: ConfigViewModel;
    readonly overview: OverviewViewModel;
    readonly mcp: AuthViewModel;
    readonly extension: ExtensionViewModel;
    readonly instances: InstanceConfigViewModel;
    readonly artifact: ArtifactViewModel;
    readonly context: ContextViewModel;
    readonly messageHistory: MessageHistoryViewModel;
    readonly messagePreferences: MessagePreferenceViewModel;
    readonly messages: MessageViewModel;
    readonly goals: GoalViewModel;
    readonly toolCalls: ToolCallViewModel;

    readonly artifactTransport: ArtifactTransport;
    readonly configTransport: ConfigTransport;
    readonly instanceTransport: InstanceTransport;
    readonly messageTransport: MessageTransport;
    readonly reverse: ConnectionTransport;
    readonly serverTransport: ServerTransport;

    readonly #approvals = new Map<string, ApprovalViewModel>();
    readonly #endpoint: Endpoint;
    readonly #runtimes = new Map<string, ProcessViewModel>();
    readonly #todos = new Map<string, TodoViewModel>();

    constructor(options: TuiClientOptions = {}) {
        const endpoint = new Endpoint({
            connectChannel: (signal) => connectControlChannel(options, signal),
        });
        this.#endpoint = endpoint;

        this.serverTransport = createServerTransport(endpoint, {
            clientKind: "tui",
        });
        this.server = new ServerSession(endpoint, this.serverTransport);

        this.configTransport = createConfigTransport(endpoint);
        this.instanceTransport = createInstanceTransport(endpoint);
        this.config = new ConfigViewModel(this.configTransport);
        this.messagePreferences = new MessagePreferenceViewModel(
            createMessagePreferenceTransport(endpoint),
        );
        this.overview = new OverviewViewModel(createOverviewTransport(endpoint));
        this.mcp = new AuthViewModel(createAuthTransport(endpoint));
        this.extension = new ExtensionViewModel(
            createExtensionRuntimeTransport(endpoint),
            createTuiPageTransport(endpoint),
            createWebPageTransport(endpoint),
        );
        this.instances = new InstanceConfigViewModel(this.instanceTransport);

        this.artifactTransport = createArtifactTransport(endpoint);
        this.artifact = new ArtifactViewModel(this.artifactTransport);
        this.context = new ContextViewModel(createContextTransport(endpoint));
        this.messageTransport = createMessageTransport(endpoint);
        this.messageHistory = new MessageHistoryViewModel({
            transport: this.messageTransport,
        });
        this.messages = new MessageViewModel({
            transport: this.messageTransport,
        });
        this.goals = new GoalViewModel({
            transport: (instance) => createTaskTransport(endpoint, instance),
        });
        this.toolCalls = new ToolCallViewModel({
            cursor: async (instance) =>
                (await createProcessTransport(endpoint, instance).snapshot()).lastSeq,
            transport: (instance) => createToolTransport(endpoint, instance),
        });
        this.reverse = createConnectionTransport(endpoint);
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

    todo(instance: string): TodoViewModel {
        let viewModel = this.#todos.get(instance);
        if (viewModel === undefined) {
            viewModel = new TodoViewModel(
                createTaskTransport(this.#endpoint, instance),
            );
            this.#todos.set(instance, viewModel);
        }
        return viewModel;
    }

    terminalTransport(instance: string): TerminalTransport {
        return createTerminalTransport(this.#endpoint, instance);
    }

    taskTransport(instance: string): TaskTransport {
        return createTaskTransport(this.#endpoint, instance);
    }

    toolTransport(instance: string): ToolTransport {
        return createToolTransport(this.#endpoint, instance);
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
            this.config.refresh(),
            this.instances.refresh(),
            this.context.refresh(),
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

export function createTuiDomainSession(
    options: TuiClientOptions = {},
): TuiDomainSession {
    return new TuiDomainSession(options);
}
