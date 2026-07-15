import type { ArtifactShareInput, ArtifactTransferStartInput } from "../dto/artifact/DtoArtifact.js";
import type { InstanceCreateDraft } from "../dto/instance/DtoInstanceCreate.js";
import type { InstanceEvent } from "../dto/instance/DtoInstanceEvent.js";
import type { OAuthApprovalDecision } from "../dto/oauth/DtoOAuthApproval.js";
import type { ApprovalDecisionValue } from "../dto/tool/DtoToolApproval.js";
import type { ToolCallQuery } from "../dto/tool/DtoToolCallRecord.js";
import { asInstanceName } from "../type/identity/TypeIdentityInstanceName.js";
import type { JsonValue } from "../type/TypeJsonValue.js";
import type { ControlEventEnvelope } from "./envelope/ProtocolEnvelopeControl.js";
import { createControlTarget, createInstanceTarget, type ControlTargetControl, type ControlTargetInstance } from "./envelope/ProtocolEnvelopeTarget.js";
import type { ControlRpcMethod, ControlRpcRequestArgs, ControlRpcResult, ControlRpcTarget } from "./method/ProtocolMethodContract.js";

type ScopedMethod<TTarget> = {
    [TMethod in ControlRpcMethod]: ControlRpcTarget<TMethod> extends TTarget ? TMethod : never;
}[ControlRpcMethod];
type ControlMethod = ScopedMethod<ControlTargetControl>;
type InstanceMethod = ScopedMethod<ControlTargetInstance>;

export interface ProtocolControlRpcConnection {
    close(): void;
    request<TMethod extends ControlRpcMethod>(method: TMethod, target: ControlRpcTarget<TMethod>, ...args: ControlRpcRequestArgs<TMethod>): Promise<ControlRpcResult<TMethod>>;
    requestWithRelay<TMethod extends ControlRpcMethod>(
        method: TMethod,
        target: ControlRpcTarget<TMethod>,
        relay: { onOutput(chunk: string): void; onRequestId?(requestId: string): void },
        ...args: ControlRpcRequestArgs<TMethod>
    ): Promise<ControlRpcResult<TMethod>>;
}

export interface ProtocolControlApprovalDecisionOptions {
    policyPatch?: JsonValue;
    reason?: string;
    remember?: boolean;
}

export class ProtocolControlRpcClient<TConnection extends ProtocolControlRpcConnection> {
    readonly #createConnection: () => TConnection;

    constructor(createConnection: () => TConnection) {
        this.#createConnection = createConnection;
    }

    createArtifactShare(defaultInstance: string, input: ArtifactShareInput) { return this.requestControl("control.artifact.createShare", { ...input, defaultInstance }); }
    listArtifactShares() { return this.requestControl("control.artifact.listShares"); }
    revokeArtifactShare(shareId: string) { return this.requestControl("control.artifact.revokeShare", { shareId }); }
    startArtifactTransfer(defaultInstance: string, input: ArtifactTransferStartInput) { return this.requestControl("control.artifact.startTransfer", { ...input, defaultInstance }); }
    getArtifactTransfer(transferId: string) { return this.requestControl("control.artifact.getTransfer", { transferId }); }
    listArtifactTransfers() { return this.requestControl("control.artifact.listTransfers"); }
    cancelArtifactTransfer(transferId: string) { return this.requestControl("control.artifact.cancelTransfer", { transferId }); }
    restartControl() { return this.requestControl("control.restart"); }
    ping() { return this.requestControl("control.ping"); }
    listInstances() { return this.requestControl("control.listInstances"); }
    listOAuthApprovals() { return this.requestControl("control.listOAuthApprovals"); }
    getMcpStatus() { return this.requestControl("control.getMcpStatus"); }
    getConfigView() { return this.requestControl("control.getConfigView"); }
    validateConfigDraft(draft: JsonValue) { return this.requestControl("control.validateConfigDraft", draft); }
    updateInstanceConfig(config: JsonValue) { return this.requestControl("control.updateInstanceConfig", config); }
    updateMcpConfig(config: JsonValue) { return this.requestControl("control.updateMcpConfig", config); }
    applyConfig() { return this.requestControl("control.applyConfig"); }
    getInstanceCreateSchema() { return this.requestControl("control.getInstanceCreateSchema"); }
    validateInstanceCreateDraft(draft: InstanceCreateDraft) { return this.requestControl("control.validateInstanceCreateDraft", draft); }
    createInstance(draft: InstanceCreateDraft) { return this.requestControl("control.createInstance", draft); }
    createReverseDeviceCode(instance: string) { return this.requestControl("control.createReverseDeviceCode", { instance }); }
    rotateReverseDeviceToken(instance: string) { return this.requestControl("control.rotateReverseDeviceToken", { instance }); }
    revokeReverseDeviceToken(instance: string) { return this.requestControl("control.revokeReverseDeviceToken", { instance }); }
    enableInstance(instanceName: string) { return this.requestControl("control.enableInstance", { instanceName }); }
    disableInstance(instanceName: string) { return this.requestControl("control.disableInstance", { instanceName }); }
    deleteInstance(instanceName: string) { return this.requestControl("control.deleteInstance", { instanceName }); }
    getSnapshot(instance: string) { return this.requestInstance("instance.getSnapshot", instance); }
    getTodo(instance: string) { return this.requestInstance("instance.todo.get", instance); }
    refreshStatus(instance: string) { return this.requestInstance("instance.refreshStatus", instance); }
    stopInstance(instance: string) { return this.requestInstance("instance.stop", instance); }
    readLogs(instance: string, params?: { fromSeq?: number; limit?: number }) { return this.requestInstance("instance.readLogs", instance, params); }
    readToolCalls(instance: string, params?: ToolCallQuery) { return this.requestInstance("instance.readToolCalls", instance, params); }
    listApprovals(instance: string) { return this.requestInstance("instance.listApprovals", instance); }
    getApproval(instance: string, approvalId: string) { return this.requestInstance("instance.getApproval", instance, { approvalId }); }
    decideApproval(instance: string, approvalId: string, decision: ApprovalDecisionValue, options: ProtocolControlApprovalDecisionOptions = {}) {
        return this.requestInstance("instance.decideApproval", instance, { approvalId, decision, ...options });
    }
    decideOAuthApproval(approvalId: string, decision: OAuthApprovalDecision) {
        return this.requestControl("control.decideOAuthApproval", { approvalId, decision });
    }
    callTool(instance: string, toolName: string, input: JsonValue) {
        return this.requestInstance("instance.callTool", instance, { input, toolName });
    }

    protected createConnection(): TConnection {
        return this.#createConnection();
    }

    protected async startInstanceRequest(
        instance: string,
        params?: { workspacePath?: string },
        relay?: { onOutput(chunk: string): void; onRequestId?(requestId: string): void }
    ) {
        if (relay === undefined) {
            return await this.requestInstance("instance.start", instance, params);
        }
        const connection = this.createConnection();
        try {
            return await connection.requestWithRelay("instance.start", createInstanceTarget(instance), relay, params);
        } finally {
            connection.close();
        }
    }

    protected async openSubscription(
        method: "instance.subscribe" | "instance.todo.subscribe",
        instance: string,
        fromSeq: number
    ): Promise<{ connection: TConnection; events: ControlEventEnvelope[] }> {
        const connection = this.createConnection();
        try {
            const target = createInstanceTarget(instance);
            const result = method === "instance.subscribe"
                ? await connection.request("instance.subscribe", target, { fromSeq })
                : await connection.request("instance.todo.subscribe", target, { fromSeq });
            return { connection, events: result.events.map((event) => toInitialEventEnvelope(instance, event)) };
        } catch (error) {
            connection.close();
            throw error;
        }
    }

    private requestControl<TMethod extends ControlMethod>(
        method: TMethod,
        ...args: ControlRpcRequestArgs<TMethod>
    ): Promise<ControlRpcResult<TMethod>> {
        return this.request(method, createControlTarget() as ControlRpcTarget<TMethod>, ...args);
    }

    private requestInstance<TMethod extends InstanceMethod>(
        method: TMethod,
        instance: string,
        ...args: ControlRpcRequestArgs<TMethod>
    ): Promise<ControlRpcResult<TMethod>> {
        return this.request(method, createInstanceTarget(instance) as ControlRpcTarget<TMethod>, ...args);
    }

    private async request<TMethod extends ControlRpcMethod>(
        method: TMethod,
        target: ControlRpcTarget<TMethod>,
        ...args: ControlRpcRequestArgs<TMethod>
    ): Promise<ControlRpcResult<TMethod>> {
        const connection = this.createConnection();
        try {
            return await connection.request(method, target, ...args);
        } finally {
            connection.close();
        }
    }
}

function toInitialEventEnvelope(instance: string, event: InstanceEvent): ControlEventEnvelope {
    return {
        event: event.type,
        payload: event as unknown as JsonValue,
        seq: event.seq,
        target: { instance: asInstanceName(instance), kind: "instance" },
        type: "event"
    };
}
