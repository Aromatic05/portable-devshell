import { TuiRuntimeControlOperations } from "./operation/Control.js";
import { TuiRuntimeExecutionOperations } from "./operation/Execution.js";
import { TuiRuntimeTmuxOperations } from "./operation/Tmux.js";
import { type TuiAppStore } from "../state/store/App.js";
import { type ConfigBatchUpdateRequest, type ConfigDraft, type ConfigUpdateInstanceRequest, type ConfigUpdateMcpRequest, type ConfigUpdateWebRequest, type InstanceCreateDraft, type InstanceCreateSchema, type InstanceCreateSummary, type JsonValue, type ReverseDeviceCodeResult } from "@portable-devshell/shared";

export interface TuiRuntimeOperationsOptions {
    clients: TuiRuntimeOperationClients;
    operationTimeoutMs?: number;
    reconnectDelayMs?: number;
    session: TuiRuntimeOperationSession;
    store: TuiAppStore;
}

export class TuiRuntimeOperations {
    readonly callTool: TuiRuntimeExecutionOperations["callTool"];
    readonly cancelArtifactTransfer: TuiRuntimeControlOperations["cancelArtifactTransfer"];
    readonly createInstance: TuiRuntimeControlOperations["createInstance"];
    readonly decideApproval: TuiRuntimeExecutionOperations["decideApproval"];
    readonly decideOAuthApproval: TuiRuntimeControlOperations["decideOAuthApproval"];
    readonly deleteInstance: TuiRuntimeControlOperations["deleteInstance"];
    readonly deleteTodo: TuiRuntimeControlOperations["deleteTodo"];
    readonly disableContext: TuiRuntimeControlOperations["disableContext"];
    readonly getInstanceCreateSchema: TuiRuntimeControlOperations["getInstanceCreateSchema"];
    readonly queueContextMessage: TuiRuntimeControlOperations["queueContextMessage"];
    readonly reloadLogs: TuiRuntimeControlOperations["reloadLogs"];
    readonly reloadPage: TuiRuntimeControlOperations["reloadPage"];
    readonly renewContext: TuiRuntimeControlOperations["renewContext"];
    readonly restartControl: TuiRuntimeControlOperations["restartControl"];
    readonly revokeArtifactShare: TuiRuntimeControlOperations["revokeArtifactShare"];
    readonly runInstanceAction: TuiRuntimeExecutionOperations["runInstanceAction"];
    readonly setInstanceEnabled: TuiRuntimeControlOperations["setInstanceEnabled"];
    readonly tmuxOperations: TuiRuntimeTmuxOperations;
    readonly updateConfig: TuiRuntimeControlOperations["updateConfig"];
    readonly updateInstanceConfig: TuiRuntimeControlOperations["updateInstanceConfig"];
    readonly updateMcpEndpoint: TuiRuntimeControlOperations["updateMcpEndpoint"];
    readonly updateWeb: TuiRuntimeControlOperations["updateWeb"];
    readonly validateConfigDraft: TuiRuntimeControlOperations["validateConfigDraft"];
    readonly validateInstanceCreateDraft: TuiRuntimeControlOperations["validateInstanceCreateDraft"];

    constructor(options: TuiRuntimeOperationsOptions) {
        const timeout = options.operationTimeoutMs ?? 30_000;
        const control = new TuiRuntimeControlOperations({
            clients: options.clients,
            operationTimeoutMs: timeout,
            reconnectDelayMs: options.reconnectDelayMs ?? 100,
            session: options.session,
            store: options.store,
        });
        const execution = new TuiRuntimeExecutionOperations({
            ...options,
            operationTimeoutMs: timeout,
        });
        this.tmuxOperations = new TuiRuntimeTmuxOperations({
            clients: options.clients,
            operationTimeoutMs: timeout,
            store: options.store,
        });
        this.callTool = execution.callTool.bind(execution);
        this.decideApproval = execution.decideApproval.bind(execution);
        this.runInstanceAction = execution.runInstanceAction.bind(execution);
        this.cancelArtifactTransfer = control.cancelArtifactTransfer.bind(control);
        this.createInstance = control.createInstance.bind(control);
        this.decideOAuthApproval = control.decideOAuthApproval.bind(control);
        this.deleteInstance = control.deleteInstance.bind(control);
        this.deleteTodo = control.deleteTodo.bind(control);
        this.disableContext = control.disableContext.bind(control);
        this.getInstanceCreateSchema = control.getInstanceCreateSchema.bind(control);
        this.queueContextMessage = control.queueContextMessage.bind(control);
        this.reloadLogs = control.reloadLogs.bind(control);
        this.reloadPage = control.reloadPage.bind(control);
        this.renewContext = control.renewContext.bind(control);
        this.restartControl = control.restartControl.bind(control);
        this.revokeArtifactShare = control.revokeArtifactShare.bind(control);
        this.setInstanceEnabled = control.setInstanceEnabled.bind(control);
        this.updateConfig = control.updateConfig.bind(control);
        this.updateInstanceConfig = control.updateInstanceConfig.bind(control);
        this.updateMcpEndpoint = control.updateMcpEndpoint.bind(control);
        this.updateWeb = control.updateWeb.bind(control);
        this.validateConfigDraft = control.validateConfigDraft.bind(control);
        this.validateInstanceCreateDraft = control.validateInstanceCreateDraft.bind(control);
    }
}

export interface TuiRuntimeOperationClients {
    artifact: {
        cancelTransfer(transferId: string): Promise<unknown>;
        revokeShare(shareId: string): Promise<unknown>;
    };
    config: {
        update(request: ConfigBatchUpdateRequest): Promise<JsonValue>;
        updateInstance(request: ConfigUpdateInstanceRequest): Promise<unknown>;
        updateMcpEndpoint(request: ConfigUpdateMcpRequest): Promise<unknown>;
        updateWeb(request: ConfigUpdateWebRequest): Promise<unknown>;
        validate(draft: ConfigDraft): Promise<unknown>;
    };
    instance: {
        create(draft: InstanceCreateDraft): Promise<{ name: string }>;
        createSchema(): Promise<InstanceCreateSchema>;
        delete(instanceName: string): Promise<unknown>;
        validateCreate(draft: InstanceCreateDraft): Promise<InstanceCreateSummary>;
    };
    reverse: {
        createCode(instance: string): Promise<Pick<ReverseDeviceCodeResult, "controllerUrl" | "deviceCode" | "expiresAt">>;
    };
    service: {
        restart(): Promise<unknown>;
    };
    todo: {
        delete(instance: string, taskId: string): Promise<unknown>;
    };
    tool: {
        call(instance: string, toolName: string, input: JsonValue, workspace: string): Promise<JsonValue>;
    };
}

export interface TuiRuntimeOperationSession {
    commands: {
        decideOAuthApproval(approvalId: string, decision: "approve" | "deny"): Promise<unknown>;
        decideToolApproval(instance: string, approvalId: string, decision: "approve" | "deny"): Promise<unknown>;
        disableContext(ctxId: string): Promise<unknown>;
        queueContextMessage(instance: string, ctxId: string, text: string): Promise<unknown>;
        refreshInstance(instance: string): Promise<unknown>;
        renewContext(ctxId: string): Promise<unknown>;
        startInstance(
            instance: string,
            options?: {
                onOutput?(chunk: string): void;
                onRequestId?(requestId: string): void;
                signal?: AbortSignal;
            },
        ): Promise<unknown>;
        stopInstance(instance: string): Promise<unknown>;
    };
    reconnect(): Promise<unknown>;
    refresh(): Promise<unknown>;
    refreshArtifacts(): Promise<unknown>;
    refreshAudit(instance: string): Promise<unknown>;
    refreshConfig(): Promise<unknown>;
    refreshInstance(instance: string): Promise<unknown>;
    refreshInstances(): Promise<unknown>;
    refreshLogs(): Promise<unknown>;
    refreshLogsForInstance(instance: string): Promise<unknown>;
    refreshMessages(instance: string): Promise<unknown>;
    refreshOAuth(): Promise<unknown>;
    refreshOverview(): Promise<unknown>;
    refreshTodo(instance: string): Promise<unknown>;
}
