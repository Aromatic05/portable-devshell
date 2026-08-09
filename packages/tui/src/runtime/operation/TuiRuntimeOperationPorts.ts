import type {
    ConfigBatchUpdateRequest,
    ConfigDraft,
    ConfigUpdateInstanceRequest,
    ConfigUpdateMcpRequest,
    ConfigUpdateWebRequest,
    InstanceCreateDraft,
    InstanceCreateSchema,
    InstanceCreateSummary,
    JsonValue,
    ReverseDeviceCodeResult,
} from "@portable-devshell/shared";

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
        call(instance: string, toolName: string, input: JsonValue): Promise<JsonValue>;
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
                workspacePath?: string;
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
    refreshLogs(): Promise<unknown>;
    refreshLogsForInstance(instance: string): Promise<unknown>;
    refreshOAuth(): Promise<unknown>;
    refreshOverview(): Promise<unknown>;
    refreshTodo(instance: string): Promise<unknown>;
}
