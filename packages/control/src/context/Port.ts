import type {
    ApprovalRequest,
    GoalManageInput,
    GoalSnapshot,
    JsonValue,
    McpContextEnvironment,
    McpContextExternalBinding,
    WaitRecord,
} from "@portable-devshell/shared";

export interface PreparedEnvironmentFacts {
    projectMemoryAgentFile: string;
    projectMemoryDirectory: string;
    projectMemoryPresent?: boolean;
    temporaryDirectory: string;
    workspace: string;
}

export interface ContextEnvironmentPort {
    prepareLocal(ctxId: string, instance: string, workspace: string, options?: {
        external?: {
            bindings: readonly McpContextExternalBinding[];
            principal: string;
        };
        beforeCommit?: (prepared: PreparedEnvironmentFacts) => Promise<void>;
        signal?: AbortSignal;
    }): Promise<PreparedEnvironmentFacts>;
    attachRemote(
        ctxId: string,
        handle: string,
        workspace?: string,
        signal?: AbortSignal,
    ): Promise<JsonValue>;
    maskRemote(
        ctxId: string,
        handle: string,
    ): Promise<{ instance: string; masked: true }>;
    ensurePrepared(
        ctxId: string,
        instance: string,
        workspace?: string,
    ): Promise<McpContextEnvironment>;
    rollbackUndisclosed(
        ctxId: string,
        instance: string,
        workspace?: string,
    ): Promise<void>;
}

export interface ContextCleanupPort {
    reconcile(ctxId?: string): Promise<void>;
    reconcileInstance(
        instance: string,
        resources: ContextInstanceCleanupPort,
    ): Promise<void>;
}

export interface ContextInstanceCleanupPort {
    releaseAlerts(workspace: string): Promise<void>;
    releaseInstanceReference(ctxId: string): Promise<void>;
}

export interface ContextWorkerPort {
    prepareWorkspace?(workspace: string): Promise<PreparedEnvironmentFacts>;
    releaseAlerts?(workspace: string): Promise<void>;
    snapshot(): { ready?: boolean };
    touchAlerts?(workspace: string): Promise<
        | void
        | { advice: Array<{ code: string; text: string }> }
    >;
    touchTemporaryDirectory?(path: string): Promise<void>;
}

export interface ContextApprovalPort {
    listApprovals(instance: string): Promise<ApprovalRequest[]>;
    cancelApproval?(
        instance: string,
        approvalId: string,
        reason?: string,
    ): Promise<ApprovalRequest>;
    decideApproval?(
        instance: string,
        approvalId: string,
        decision: "approve" | "deny",
    ): Promise<ApprovalRequest>;
}

export interface ContextInstancePort {
    approval?: ContextApprovalPort;
    assertReady(instance: string): void;
    connectInstance(instance: string, reference: string): Promise<JsonValue>;
    contextTerminated?(
        instance: string,
        ctxId: string,
        reason: "disabled" | "expired",
    ): Promise<void>;
    prepareWorkspace(
        instance: string,
        workspace: string,
    ): Promise<PreparedEnvironmentFacts>;
    readAlerts(
        instance: string,
        workspace: string,
    ): Promise<{ advice: Array<{ code: string; text: string }> }>;
    releaseAlerts(instance: string, workspace: string): Promise<void>;
    releaseInstanceReference(
        instance: string,
        reference: string,
    ): Promise<void>;
    touchAlerts(
        instance: string,
        workspace: string,
    ): Promise<void | { advice: Array<{ code: string; text: string }> }>;
    touchTemporaryDirectory(instance: string, path: string): Promise<void>;
    readGoal?(
        instance: string,
        ctxId: string,
    ): Promise<GoalSnapshot | undefined>;
    manageGoal?(
        instance: string,
        input: GoalManageInput,
        ctxId: string,
    ): Promise<GoalSnapshot | undefined>;
    listWaits?(instance: string): Promise<WaitRecord[]>;
    cancelWait?(instance: string, waitId: string): Promise<WaitRecord>;
    consumeWait?(instance: string, waitId: string): Promise<WaitRecord>;
}
