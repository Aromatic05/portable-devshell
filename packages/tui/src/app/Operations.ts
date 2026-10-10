import { TuiRuntimeControlOperations } from "./operation/Control.js";
import { TuiRuntimeExecutionOperations } from "./operation/Execution.js";
import { TuiRuntimeTmuxOperations } from "./operation/Tmux.js";
import { type TuiAppStore } from "../state/store/App.js";
import type { TuiDomainSession } from "./control/Client.js";
import type {
    ArtifactTransport,
    ConfigTransport,
    InstanceTransport,
    ConnectionTransport,
    ServerTransport,
    TaskTransport,
    ToolTransport,
} from "@portable-devshell/shared";

export interface TuiRuntimeOperationsOptions {
    clients: TuiRuntimeOperationClients;
    domains: TuiDomainSession;
    operationTimeoutMs?: number;
    reconnect: () => Promise<void>;
    reconnectDelayMs?: number;
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
            domains: options.domains,
            operationTimeoutMs: timeout,
            reconnect: options.reconnect,
            reconnectDelayMs: options.reconnectDelayMs ?? 100,
            store: options.store,
        });
        const execution = new TuiRuntimeExecutionOperations({
            clients: options.clients,
            domains: options.domains,
            operationTimeoutMs: timeout,
            reconnect: options.reconnect,
            store: options.store,
        });
        this.tmuxOperations = new TuiRuntimeTmuxOperations({
            clients: options.clients,
            domains: options.domains,
            operationTimeoutMs: timeout,
            reconnect: options.reconnect,
        });
        this.callTool = execution.callTool.bind(execution);
        this.decideApproval = execution.decideApproval.bind(execution);
        this.runInstanceAction = execution.runInstanceAction.bind(execution);
        this.cancelArtifactTransfer =
            control.cancelArtifactTransfer.bind(control);
        this.createInstance = control.createInstance.bind(control);
        this.decideOAuthApproval = control.decideOAuthApproval.bind(control);
        this.deleteInstance = control.deleteInstance.bind(control);
        this.deleteTodo = control.deleteTodo.bind(control);
        this.disableContext = control.disableContext.bind(control);
        this.getInstanceCreateSchema =
            control.getInstanceCreateSchema.bind(control);
        this.queueContextMessage = control.queueContextMessage.bind(control);
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
        this.validateInstanceCreateDraft =
            control.validateInstanceCreateDraft.bind(control);
    }
}

/**
 * The operation layer composes the same explicit domain transports the session
 * owns; it is not a second client bundle.
 */
export interface TuiRuntimeOperationClients {
    artifact: ArtifactTransport;
    config: ConfigTransport;
    instance: InstanceTransport;
    reverse: ConnectionTransport;
    server: ServerTransport;
    task(instance: string): TaskTransport;
    tool(instance: string): ToolTransport;
}

export interface TuiRuntimeOperationContext {
    clients: TuiRuntimeOperationClients;
    domains: TuiDomainSession;
    reconnect: () => Promise<void>;
}
