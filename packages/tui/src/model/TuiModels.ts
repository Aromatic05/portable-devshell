import type {
    ApprovalDecision,
    ApprovalRequest,
    InstanceSnapshot,
    JsonValue,
    ToolCallApprovalDecision,
    ToolCallRecord,
    ToolCallSource,
    ToolCallStatus
} from "@portable-devshell/shared";
import { asInstanceName } from "@portable-devshell/shared";

export type { TuiControlEventEnvelope } from "../control/TuiControlRequest.js";

export interface TuiInstanceView {
    mcpEnabled: boolean;
    name: string;
    snapshot?: InstanceSnapshot;
}

export interface TuiLogEntry {
    bytes: number;
    callId?: string;
    instance: string;
    preview?: string;
    receivedAt: string;
    requestId?: string;
    seq: number;
    ctxId?: string;
    source?: ToolCallSource;
    stream: "stderr" | "stdout";
    tail?: string;
    toolName?: string;
}

export type TuiConfigView = Record<string, JsonValue>;

export class TuiInstanceModel {
    readonly #entries = new Map<string, TuiInstanceView>();
    readonly #order: string[] = [];

    reset(entries: ReadonlyArray<{ mcpEnabled: boolean; name: string }>): void {
        const nextOrder = entries.map((entry) => entry.name);
        const nextNames = new Set(nextOrder);

        for (const name of this.#entries.keys()) {
            if (!nextNames.has(name)) {
                this.#entries.delete(name);
            }
        }

        this.#order.splice(0, this.#order.length, ...nextOrder);

        for (const entry of entries) {
            const current = this.#entries.get(entry.name);
            this.#entries.set(entry.name, {
                mcpEnabled: entry.mcpEnabled,
                name: entry.name,
                snapshot: current?.snapshot
            });
        }
    }

    upsertSnapshot(snapshot: InstanceSnapshot): void {
        const current = this.#entries.get(snapshot.name);

        if (current === undefined) {
            this.#order.push(snapshot.name);
        }

        this.#entries.set(snapshot.name, {
            mcpEnabled: current?.mcpEnabled ?? false,
            name: snapshot.name,
            snapshot: cloneSnapshot(snapshot)
        });
    }

    list(): TuiInstanceView[] {
        return this.#order
            .map((name) => this.#entries.get(name))
            .filter((entry): entry is TuiInstanceView => entry !== undefined)
            .map((entry) => ({
                ...entry,
                snapshot: entry.snapshot === undefined ? undefined : cloneSnapshot(entry.snapshot)
            }));
    }

    get(name: string): TuiInstanceView | undefined {
        const entry = this.#entries.get(name);

        if (entry === undefined) {
            return undefined;
        }

        return {
            ...entry,
            snapshot: entry.snapshot === undefined ? undefined : cloneSnapshot(entry.snapshot)
        };
    }
}

export class TuiLogModel {
    readonly #maxEntriesPerInstance: number;
    readonly #entries = new Map<string, TuiLogEntry[]>();

    constructor(maxEntriesPerInstance = 100) {
        this.#maxEntriesPerInstance = maxEntriesPerInstance;
    }

    pruneInstances(instanceNames: ReadonlySet<string>): void {
        for (const name of this.#entries.keys()) {
            if (!instanceNames.has(name)) {
                this.#entries.delete(name);
            }
        }
    }

    append(entry: TuiLogEntry): void {
        const current = this.#entries.get(entry.instance) ?? [];
        const next = [...current, { ...entry }];

        if (next.length > this.#maxEntriesPerInstance) {
            next.splice(0, next.length - this.#maxEntriesPerInstance);
        }

        this.#entries.set(entry.instance, next);
    }

    list(instance?: string): TuiLogEntry[] {
        if (instance !== undefined) {
            return (this.#entries.get(instance) ?? []).map(cloneLogEntry);
        }

        return TuiEventMerger.mergeLogs(this.#entries).map(cloneLogEntry);
    }
}

export class TuiToolAuditModel {
    readonly #records = new Map<string, ToolCallRecord>();

    replaceInstance(instance: string, records: ReadonlyArray<ToolCallRecord>): void {
        for (const key of this.#records.keys()) {
            if (key.startsWith(`${instance}:`)) {
                this.#records.delete(key);
            }
        }

        for (const record of records) {
            this.#records.set(recordKey(instance, record.callId), cloneToolCallRecord(record));
        }
    }

    pruneInstances(instanceNames: ReadonlySet<string>): void {
        for (const [key, record] of this.#records.entries()) {
            if (!instanceNames.has(record.instance)) {
                this.#records.delete(key);
            }
        }
    }

    upsertEvent(instance: string, eventType: string, data: Record<string, JsonValue>): void {
        if (
            eventType !== "toolCall.queued" &&
            eventType !== "toolCall.pendingApproval" &&
            eventType !== "toolCall.running" &&
            eventType !== "toolCall.completed" &&
            eventType !== "toolCall.failed" &&
            eventType !== "toolCall.denied" &&
            eventType !== "toolCall.expired" &&
            eventType !== "toolCall.queueTimeout" &&
            eventType !== "toolCall.cancelled"
        ) {
            return;
        }

        const callId = readOptionalString(data.callId);

        if (callId === undefined) {
            return;
        }

        const current = this.#records.get(recordKey(instance, callId));
        const next = {
            approvalId: readOptionalString(data.approvalId) ?? current?.approvalId,
            callId,
            completedAt: readOptionalString(data.completedAt) ?? current?.completedAt,
            decision: readApprovalDecision(data.decision) ?? current?.decision,
            error: readOptionalString(data.errorCode) ?? current?.error,
            exitCode: readOptionalNumberOrNull(data.exitCode) ?? current?.exitCode,
            input: data.input ?? current?.input,
            inputSummary: readOptionalString(data.inputSummary) ?? current?.inputSummary ?? "",
            instance: asInstanceName(instance),
            output: data.output === undefined ? current?.output : data.output,
            requestId: readOptionalString(data.requestId) ?? current?.requestId,
            ctxId: readOptionalString(data.ctxId) ?? current?.ctxId,
            source: readToolCallSource(data.source) ?? current?.source ?? "tui",
            taskId: readOptionalString(data.taskId) ?? current?.taskId,
            todoItemId: readOptionalString(data.todoItemId) ?? current?.todoItemId,
            startedAt: readOptionalString(data.startedAt) ?? current?.startedAt ?? new Date(0).toISOString(),
            status: readToolCallStatus(data.status) ?? current?.status ?? "running",
            stderrBytes: readOptionalNumber(data.stderrBytes) ?? current?.stderrBytes,
            stdoutBytes: readOptionalNumber(data.stdoutBytes) ?? current?.stdoutBytes,
            termination: data.termination === "exited" || data.termination === "signaled" || data.termination === "timeout" ? data.termination : current?.termination,
            toolName: readOptionalString(data.toolName) ?? current?.toolName ?? ""
        } satisfies ToolCallRecord;

        this.#records.set(recordKey(instance, callId), next);
    }

    list(instance?: string): ToolCallRecord[] {
        return TuiEventMerger.mergeToolCalls(this.#records, instance).map(cloneToolCallRecord);
    }
}

export class TuiApprovalInboxModel {
    readonly #approvals = new Map<string, ApprovalRequest>();

    replaceInstance(instance: string, approvals: ReadonlyArray<ApprovalRequest>): void {
        for (const [approvalId, approval] of this.#approvals.entries()) {
            if (approval.instance === instance) {
                this.#approvals.delete(approvalId);
            }
        }

        for (const approval of approvals) {
            this.#approvals.set(approval.approvalId, cloneApprovalRequest(approval));
        }
    }

    pruneInstances(instanceNames: ReadonlySet<string>): void {
        for (const [approvalId, approval] of this.#approvals.entries()) {
            if (!instanceNames.has(approval.instance)) {
                this.#approvals.delete(approvalId);
            }
        }
    }

    upsertEvent(instance: string, data: Record<string, JsonValue>): void {
        const approvalId = readOptionalString(data.approvalId);
        const callId = readOptionalString(data.callId);
        const createdAt = readOptionalString(data.createdAt);
        const expiresAt = readOptionalString(data.expiresAt);
        const inputSummary = readOptionalString(data.inputSummary);
        const riskLevel = readRiskLevel(data.riskLevel);
        const source = readToolCallSource(data.source);
        const status = readApprovalStatus(data.status);
        const toolName = readOptionalString(data.toolName);

        if (
            approvalId === undefined ||
            callId === undefined ||
            createdAt === undefined ||
            expiresAt === undefined ||
            inputSummary === undefined ||
            riskLevel === undefined ||
            source === undefined ||
            status === undefined ||
            toolName === undefined
        ) {
            return;
        }

        const current = this.#approvals.get(approvalId);
        const next: ApprovalRequest = {
            approvalId,
            callId,
            createdAt,
            decision: readDecision(data, current?.decision),
            expiresAt,
            inputSummary,
            instance: asInstanceName(instance),
            reason: readOptionalString(data.reason) ?? current?.reason ?? "",
            requestId: readOptionalString(data.requestId) ?? current?.requestId,
            riskLevel,
            ctxId: readOptionalString(data.ctxId) ?? current?.ctxId,
            source,
            status,
            toolName
        };

        this.#approvals.set(approvalId, next);
    }

    listPending(instance?: string): ApprovalRequest[] {
        return TuiEventMerger.mergeApprovals(this.#approvals, instance).map(cloneApprovalRequest);
    }
}

export class TuiConfigModel {
    #view?: TuiConfigView;

    set(view: TuiConfigView): void {
        this.#view = cloneConfigView(view);
    }

    get(): TuiConfigView | undefined {
        return this.#view === undefined ? undefined : cloneConfigView(this.#view);
    }
}

export class TuiEventMerger {
    static mergeToolCalls(records: ReadonlyMap<string, ToolCallRecord>, instance?: string): ToolCallRecord[] {
        return [...records.values()]
            .filter((record) => instance === undefined || record.instance === instance)
            .sort((left, right) => {
                const startedAt = right.startedAt.localeCompare(left.startedAt);

                if (startedAt !== 0) {
                    return startedAt;
                }

                return right.callId.localeCompare(left.callId);
            });
    }

    static mergeApprovals(approvals: ReadonlyMap<string, ApprovalRequest>, instance?: string): ApprovalRequest[] {
        return [...approvals.values()]
            .filter((approval) => approval.status === "pending")
            .filter((approval) => instance === undefined || approval.instance === instance)
            .sort((left, right) => {
                const createdAt = right.createdAt.localeCompare(left.createdAt);

                if (createdAt !== 0) {
                    return createdAt;
                }

                return right.approvalId.localeCompare(left.approvalId);
            });
    }

    static mergeLogs(entries: ReadonlyMap<string, ReadonlyArray<TuiLogEntry>>): TuiLogEntry[] {
        return [...entries.values()]
            .flatMap((value) => value)
            .sort((left, right) => {
                const receivedAt = right.receivedAt.localeCompare(left.receivedAt);

                if (receivedAt !== 0) {
                    return receivedAt;
                }

                if (left.instance !== right.instance) {
                    return left.instance.localeCompare(right.instance);
                }

                return right.seq - left.seq;
            });
    }
}

function recordKey(instance: string, callId: string): string {
    return `${instance}:${callId}`;
}

function cloneSnapshot(snapshot: InstanceSnapshot): InstanceSnapshot {
    return { ...snapshot };
}

function cloneToolCallRecord(record: ToolCallRecord): ToolCallRecord {
    return { ...record };
}

function cloneApprovalRequest(approval: ApprovalRequest): ApprovalRequest {
    return {
        ...approval,
        ...(approval.decision === undefined ? {} : { decision: { ...approval.decision } })
    };
}

function cloneLogEntry(entry: TuiLogEntry): TuiLogEntry {
    return { ...entry };
}

function cloneConfigView(view: TuiConfigView): TuiConfigView {
    return JSON.parse(JSON.stringify(view)) as TuiConfigView;
}

function readOptionalString(value: JsonValue | undefined): string | undefined {
    return typeof value === "string" ? value : undefined;
}

function readOptionalNumber(value: JsonValue | undefined): number | undefined {
    return typeof value === "number" ? value : undefined;
}

function readOptionalNumberOrNull(value: JsonValue | undefined): number | null | undefined {
    return typeof value === "number" || value === null ? value : undefined;
}

function readToolCallStatus(value: JsonValue | undefined): ToolCallStatus | undefined {
    if (
        value === "queued" ||
        value === "pendingApproval" ||
        value === "running" ||
        value === "completed" ||
        value === "failed" ||
        value === "denied" ||
        value === "expired" ||
        value === "queueTimeout" ||
        value === "cancelled"
    ) {
        return value;
    }

    return undefined;
}

function readToolCallSource(value: JsonValue | undefined): ToolCallSource | undefined {
    if (value === "cli" || value === "tui" || value === "mcp") {
        return value;
    }

    return undefined;
}

function readApprovalDecision(value: JsonValue | undefined): ToolCallApprovalDecision | undefined {
    if (value === "approved" || value === "denied" || value === "expired") {
        return value;
    }

    return undefined;
}

function readApprovalStatus(value: JsonValue | undefined): ApprovalRequest["status"] | undefined {
    if (value === "pending" || value === "approved" || value === "denied" || value === "expired" || value === "cancelled") {
        return value;
    }

    return undefined;
}

function readRiskLevel(value: JsonValue | undefined): ApprovalRequest["riskLevel"] | undefined {
    if (value === "low" || value === "medium" || value === "high") {
        return value;
    }

    return undefined;
}

function readDecision(
    data: Record<string, JsonValue>,
    current?: ApprovalDecision
): ApprovalDecision | undefined {
    const decision = data.decision;

    if (decision !== "approve" && decision !== "deny") {
        return current === undefined ? undefined : { ...current };
    }

    const approvalId = readOptionalString(data.approvalId);
    const decidedAt = readOptionalString(data.decidedAt);
    const decidedBy = data.decidedBy;

    if (
        approvalId === undefined ||
        decidedAt === undefined ||
        (decidedBy !== "cli" && decidedBy !== "tui" && decidedBy !== "policy")
    ) {
        return current === undefined ? undefined : { ...current };
    }

    return {
        approvalId,
        decidedAt,
        decidedBy,
        decision,
        ...(data.policyPatch === undefined ? {} : { policyPatch: data.policyPatch }),
        ...(readOptionalString(data.reason) === undefined ? {} : { reason: readOptionalString(data.reason) }),
        ...(data.remember === true ? { remember: true } : {})
    };
}
