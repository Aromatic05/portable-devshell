import type { TuiClients } from "./client/TuiClientComposition.js";
import type { TuiControlSession } from "./control/TuiControlSession.js";
import { TuiRuntimeControlOperations } from "./operation/TuiRuntimeControlOperations.js";
import { TuiRuntimeExecutionOperations } from "./operation/TuiRuntimeExecutionOperations.js";
import { TuiRuntimeTmuxOperations } from "./operation/TuiRuntimeTmuxOperations.js";
import type { TuiAppStore } from "../state/TuiAppStore.js";

export interface TuiRuntimeOperationsOptions {
    clients: TuiClients;
    operationTimeoutMs?: number;
    reconnectDelayMs?: number;
    session: TuiControlSession;
    store: TuiAppStore;
}

export class TuiRuntimeOperations {
    readonly callTool: TuiRuntimeExecutionOperations["callTool"];
    readonly cancelArtifactTransfer: TuiRuntimeControlOperations["cancelArtifactTransfer"];
    readonly createInstance: TuiRuntimeControlOperations["createInstance"];
    readonly decideApproval: TuiRuntimeExecutionOperations["decideApproval"];
    readonly decideOAuthApproval: TuiRuntimeControlOperations["decideOAuthApproval"];
    readonly deleteInstance: TuiRuntimeControlOperations["deleteInstance"];
    readonly getInstanceCreateSchema: TuiRuntimeControlOperations["getInstanceCreateSchema"];
    readonly queueContextMessage: TuiRuntimeControlOperations["queueContextMessage"];
    readonly reloadLogs: TuiRuntimeControlOperations["reloadLogs"];
    readonly reloadPage: TuiRuntimeControlOperations["reloadPage"];
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
        });
        this.callTool = execution.callTool.bind(execution);
        this.decideApproval = execution.decideApproval.bind(execution);
        this.runInstanceAction = execution.runInstanceAction.bind(execution);
        this.cancelArtifactTransfer = control.cancelArtifactTransfer.bind(control);
        this.createInstance = control.createInstance.bind(control);
        this.decideOAuthApproval = control.decideOAuthApproval.bind(control);
        this.deleteInstance = control.deleteInstance.bind(control);
        this.getInstanceCreateSchema = control.getInstanceCreateSchema.bind(control);
        this.queueContextMessage = control.queueContextMessage.bind(control);
        this.reloadLogs = control.reloadLogs.bind(control);
        this.reloadPage = control.reloadPage.bind(control);
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
