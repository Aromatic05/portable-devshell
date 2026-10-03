import {
    toRemoteError,
    type ConversationPreferencesPatch,
    type ConversationPreferencesSnapshot,
    type RuntimeStartOptions,
    type ToolCallRecord,
    type TodoReadInput,
} from "@portable-devshell/shared";

import {
    createTuiDomainSession,
    type TuiDomainSession,
} from "./Client.js";
import { TuiAppStore } from "../../state/store/App.js";

export interface TuiControlSessionOptions {
    domains?: TuiDomainSession;
    store?: TuiAppStore;
}

export class TuiControlSession {
    readonly domains: TuiDomainSession;
    readonly #store: TuiAppStore;
    readonly #offService: () => void;
    #started = false;

    readonly commands = {
        decideOAuthApproval: async (
            approvalId: string,
            decision: "approve" | "deny",
        ) => {
            await this.domains.mcp.decideApproval(approvalId, decision);
        },
        decideToolApproval: async (
            instance: string,
            approvalId: string,
            decision: "approve" | "deny",
        ) => {
            const approval = this.domains.approval(instance);
            await approval.load(instance);
            await approval.decide(approvalId, decision);
        },
        disableContext: async (ctxId: string) => {
            await this.domains.context.disable(ctxId);
        },
        queueContextMessage: async (
            instance: string,
            ctxId: string,
            text: string,
        ) => {
            await this.domains.messages.queue(instance, ctxId, text);
        },
        refreshInstance: async (instance: string) => {
            await this.refreshInstance(instance);
        },
        renewContext: async (ctxId: string) => {
            await this.domains.context.renew(ctxId);
        },
        startInstance: async (
            instance: string,
            options: RuntimeStartOptions = {},
        ) => {
            const runtime = this.domains.runtime(instance);
            await runtime.load(instance);
            return await runtime.start(options);
        },
        stopInstance: async (instance: string) => {
            const runtime = this.domains.runtime(instance);
            await runtime.load(instance);
            return await runtime.stop();
        },
    };

    constructor(options: TuiControlSessionOptions = {}) {
        this.domains = options.domains ?? createTuiDomainSession();
        this.#store = options.store ?? new TuiAppStore();
        this.#offService = this.domains.service.subscribe(() =>
            this.#syncConnection(),
        );
        this.#syncConnection();
    }

    get store(): TuiAppStore {
        return this.#store;
    }

    async start(): Promise<void> {
        if (this.#started) return;
        this.#started = true;
        this.#store.setConnectionState("connecting");
        try {
            await this.domains.load();
            this.#syncConnection();
        } catch (error) {
            this.#applyConnectionFailure(error);
        }
    }

    async stop(): Promise<void> {
        if (!this.#started) return;
        this.#started = false;
        this.#offService();
        this.domains.close();
    }

    async reconnect(): Promise<void> {
        if (!this.#started) return;
        this.#store.setConnectionState("connecting");
        try {
            await this.domains.reconnect();
            this.#syncConnection();
        } catch (error) {
            this.#applyConnectionFailure(error);
            throw error;
        }
    }

    async refreshConfig(
        _generation?: number,
        signal?: AbortSignal,
    ): Promise<void> {
        if (signal?.aborted) return;
        await this.domains.config.refresh();
    }

    async refreshInstances(
        _generation?: number,
        signal?: AbortSignal,
    ): Promise<void> {
        if (signal?.aborted) return;
        await this.domains.instances.refresh();
    }

    async refreshOverview(
        _generation?: number,
        signal?: AbortSignal,
    ): Promise<void> {
        if (signal?.aborted) return;
        await this.domains.overview.refresh();
    }

    async refreshOAuth(
        _generation?: number,
        signal?: AbortSignal,
    ): Promise<void> {
        if (signal?.aborted) return;
        await this.domains.mcp.refresh();
    }

    async refreshAudit(
        instance: string,
        _generation?: number,
        signal?: AbortSignal,
    ): Promise<void> {
        if (signal?.aborted) return;
        const runtime = this.domains.runtime(instance);
        await Promise.all([
            this.domains.context.refresh(),
            runtime.load(instance).then(() => runtime.readLogs()),
            this.domains.approval(instance).load(instance),
            this.domains.toolCalls.load(instance),
            this.domains.conversation.refreshInstance(instance),
            this.domains.messages.refreshInstance(instance),
        ]);
    }

    async refreshMessages(
        _generation?: number,
        signal?: AbortSignal,
    ): Promise<void> {
        if (signal?.aborted) return;
        await Promise.all([
            this.domains.instances.refresh(),
            this.domains.context.refresh(),
        ]);
        if (signal?.aborted) return;
        const instances = this.domains.instances.state.instances.map(
            ({ name }) => name,
        );
        await Promise.all([
            this.domains.conversation.load(instances),
            this.domains.messages.load(instances),
        ]);
    }

    async refreshExtensionPages(
        _generation?: number,
        signal?: AbortSignal,
    ): Promise<void> {
        if (signal?.aborted) return;
        await this.domains.extension.refreshCatalogs();
    }

    async refreshExtensionPage(
        pageId: string,
        _generation?: number,
        signal?: AbortSignal,
    ): Promise<void> {
        if (signal?.aborted) return;
        await this.domains.extension.readTuiPage(pageId);
    }

    async invokeExtensionPageAction(
        pageId: string,
        actionId: string,
        itemId?: string,
    ): Promise<void> {
        await this.domains.extension.tuiAction(pageId, actionId, itemId);
    }

    async refreshConversationPreferences(
        _generation?: number,
        signal?: AbortSignal,
    ): Promise<void> {
        if (signal?.aborted) return;
        await this.domains.conversation.refreshPreferences();
    }

    async updateConversationPreferences(
        patch: ConversationPreferencesPatch,
    ): Promise<ConversationPreferencesSnapshot> {
        return await this.domains.conversation.updatePreferences(patch);
    }

    async refreshToolCallsForInstance(
        instance: string,
        _generation?: number,
        signal?: AbortSignal,
    ): Promise<void> {
        if (signal?.aborted) return;
        await this.domains.toolCalls.load(instance);
    }

    async readToolCallDetail(
        instance: string,
        callId: string,
    ): Promise<ToolCallRecord | undefined> {
        return (await this.domains.toolCalls.readDetail(instance, callId))[0];
    }

    async refreshTodo(
        instance: string,
        _generation?: number,
        signal?: AbortSignal,
        input?: TodoReadInput,
    ): Promise<void> {
        if (signal?.aborted) return;
        await Promise.all([
            this.domains.todo(instance).load(instance, input),
            this.domains.goals.load(instance),
        ]);
    }

    async refreshArtifacts(_generation?: number): Promise<void> {
        await this.domains.artifact.refresh();
    }

    async refreshInstance(
        instance: string,
        _generation?: number,
    ): Promise<number | undefined> {
        const runtime = this.domains.runtime(instance);
        await Promise.all([
            runtime.load(instance),
            this.domains.approval(instance).load(instance),
            this.domains.todo(instance).load(instance),
            this.domains.goals.load(instance),
        ]);
        return runtime.state.lastSeq;
    }

    homeDirectory(instance: string): string | undefined {
        return this.domains.instances.state.instances.find(
            (entry) => entry.name === instance,
        )?.homeDirectory;
    }

    toolCallsForInstance(instance: string): readonly ToolCallRecord[] {
        return this.domains.toolCalls.state.instances[instance]?.calls ?? [];
    }

    async refresh(_generation?: number): Promise<void> {
        await Promise.all([
            this.domains.config.refresh(),
            this.domains.instances.refresh(),
            this.domains.context.refresh(),
            this.domains.artifact.refresh(),
            this.domains.overview.refresh(),
            this.domains.mcp.refresh(),
            this.domains.extension.refreshCatalogs(),
            this.domains.conversation.refreshPreferences(),
        ]);
    }

    #syncConnection(): void {
        const service = this.domains.service.state;
        if (service.status === "online") {
            this.#store.setConnectionState("connected");
            return;
        }
        if (service.status === "connecting") {
            this.#store.setConnectionState("connecting");
            return;
        }
        if (service.failure !== undefined) {
            const error = toRemoteError(service.failure);
            this.#store.setConnectionState("error", {
                code: error.code,
                message: error.message,
            });
            return;
        }
        this.#store.setConnectionState("disconnected");
    }

    #applyConnectionFailure(error: unknown): void {
        const failure = toRemoteError(error);
        this.#store.setConnectionState("error", {
            code: failure.code,
            message: failure.message,
        });
        this.#store.setPanelError("control", failure);
    }
}
