import type {
    ArtifactShareResult,
    ArtifactTransferRecord,
} from "../dto/artifact/DtoArtifact.js";
import type { ContextMessageRecord } from "../dto/context/DtoContextMessage.js";
import type { McpContextRecord } from "../dto/context/DtoContextRecord.js";
import { CONTROL_PROTOCOL_VERSION } from "../dto/DtoControlProtocol.js";
import type { InstanceEvent } from "../dto/instance/DtoInstanceEvent.js";
import type { InstanceListEntry } from "../dto/instance/DtoInstanceRuntime.js";
import type { InstanceLogEntry } from "../dto/instance/DtoInstanceLog.js";
import type { InstanceSnapshot } from "../dto/instance/DtoInstanceSnapshot.js";
import type { TodoReadResult } from "../dto/instance/DtoTodo.js";
import type { OAuthApprovalRequest } from "../dto/oauth/DtoOAuthApproval.js";
import type { OperationalOverview } from "../dto/overview/DtoOperationalOverview.js";
import type { ApprovalRequest } from "../dto/tool/DtoToolApproval.js";
import type { ToolCallRecord } from "../dto/tool/DtoToolCallRecord.js";
import type { JsonValue } from "../type/TypeJsonValue.js";
import type { ControlClients, ControlServiceStatus, McpRuntimeStatus } from "../client/ControlClients.js";
import { withRequestTimeout } from "../client/RequestTimeout.js";
import type { InstanceEventStreamPort, InstanceStreamMessage } from "../client/InstanceEventStream.js";

export type ControlInstanceReadKey =
    | "snapshot"
    | "logs"
    | "approvals"
    | "todo"
    | "toolCalls"
    | "comments";

export interface ControlInstanceReadState {
    approvals: ApprovalRequest[];
    commentCalls: ToolCallRecord[];
    contextMessages: ContextMessageRecord[];
    logs: InstanceLogEntry[];
    sequence: number;
    snapshot?: InstanceSnapshot;
    todo?: TodoReadResult;
    toolCalls: ToolCallRecord[];
}

export type ControlGlobalReadKey =
    | "artifacts"
    | "config"
    | "contexts"
    | "instances"
    | "mcp"
    | "oauthApprovals"
    | "overview";

export interface ControlReadFailure {
    error: Error;
    id: string;
    instance?: string;
    key: ControlGlobalReadKey | ControlInstanceReadKey | "stream";
}

export interface ControlReadModelState {
    artifactShares: ArtifactShareResult[];
    artifactTransfers: ArtifactTransferRecord[];
    configView?: Record<string, JsonValue>;
    contexts: McpContextRecord[];
    failures: Record<string, ControlReadFailure>;
    instances: InstanceListEntry[];
    instanceState: Record<string, ControlInstanceReadState>;
    mcpStatus?: McpRuntimeStatus;
    oauthApprovals: OAuthApprovalRequest[];
    overview?: OperationalOverview;
    service?: ControlServiceStatus;
}

export interface ControlReadModelLoadOptions {
    artifacts?: boolean;
    config?: boolean;
    serviceStatus?: boolean;
}

type InstanceReadValue =
    | InstanceSnapshot
    | InstanceLogEntry[]
    | ApprovalRequest[]
    | TodoReadResult
    | ToolCallRecord[]
    | { commentCalls: ToolCallRecord[]; contextMessages: ContextMessageRecord[] }
    | { sequence: number; snapshot: InstanceSnapshot };

export interface ControlReadModelOptions {
    clients: ControlClients;
    onEvent?(event: InstanceEvent): void;
    requestTimeoutMs?: number;
    retryBaseMs?: number;
    scheduleDelayMs?: number;
    stableAfterMs?: number;
}

const instanceKeys: readonly ControlInstanceReadKey[] = [
    "snapshot",
    "logs",
    "approvals",
    "todo",
    "toolCalls",
    "comments",
];

export class ControlReadModel {
    readonly #clients: ControlClients;
    readonly #listeners = new Set<() => void>();
    readonly #onEvent?: (event: InstanceEvent) => void;
    readonly #requestTimeoutMs: number;
    readonly #retryBaseMs: number;
    readonly #scheduleDelayMs: number;
    readonly #stableAfterMs: number;
    readonly #versions = new Map<string, number>();
    readonly #refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
    readonly #pendingKeys = new Map<string, Set<ControlInstanceReadKey>>();
    readonly #authoritativeSnapshots = new Map<string, InstanceSnapshot>();
    readonly #decidedToolApprovals = new Map<string, Set<string>>();
    readonly #decidedOAuthApprovals = new Set<string>();
    readonly #streams = new Map<string, InstanceEventStreamPort>();
    readonly #streamTokens = new Map<string, number>();
    readonly #streamRetries = new Map<string, ReturnType<typeof setTimeout>>();
    readonly #streamStableTimers = new Map<string, ReturnType<typeof setTimeout>>();
    readonly #streamAttempts = new Map<string, number>();
    readonly #gapStreaks = new Map<string, number>();
    #epoch = 0;
    #loadOptions: ControlReadModelLoadOptions = {};
    #state = createInitialControlReadModelState();

    constructor(options: ControlReadModelOptions) {
        this.#clients = options.clients;
        this.#onEvent = options.onEvent;
        this.#requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
        this.#retryBaseMs = options.retryBaseMs ?? 1_000;
        this.#scheduleDelayMs = options.scheduleDelayMs ?? 100;
        this.#stableAfterMs = options.stableAfterMs ?? Math.max(1_000, this.#retryBaseMs * 4);
    }

    get state(): Readonly<ControlReadModelState> {
        return this.#state;
    }

    subscribe(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    async load(options: ControlReadModelLoadOptions = {}): Promise<void> {
        this.reset();
        this.#loadOptions = options;
        const epoch = this.#epoch;
        const hello = await this.#request(this.#clients.service.hello(), "service.hello");
        if (hello.protocolVersion !== CONTROL_PROTOCOL_VERSION) {
            throw new Error(`Incompatible control protocol version: ${hello.protocolVersion}.`);
        }
        const [service, instances] = await Promise.all([
            options.serviceStatus === false
                ? this.#request(this.#clients.service.ping(), "service.ping").then(() => undefined)
                : this.#request(this.#clients.service.status(), "service.status"),
            this.#request(this.#clients.instance.list(), "instance.list"),
        ]);
        if (!this.#current(epoch)) return;
        this.#state.service = service;
        this.#applyInstances(instances);
        this.#emit();
        await Promise.all([
            this.refreshMcp(epoch),
            this.refreshOverview(epoch),
            this.refreshContexts(epoch),
            options.config === true ? this.refreshConfig(epoch) : Promise.resolve(),
            options.artifacts === true ? this.refreshArtifacts(epoch) : Promise.resolve(),
            ...instances
                .filter((instance) => instance.snapshot.status === "ready" || instance.snapshot.status === "running")
                .map(async ({ name }) => await this.refreshInstance(name, instanceKeys, undefined, epoch)),
        ]);
        if (!this.#current(epoch)) return;
        this.#replaceSubscriptions(instances.map(({ name }) => name), epoch);
    }

    async refreshControl(): Promise<void> {
        const epoch = this.#epoch;
        const reads: Promise<unknown>[] = [
            this.#readGlobal("instances", this.#clients.instance.list(), (value) => this.#applyInstances(value), epoch),
            this.refreshMcp(epoch),
            this.refreshContexts(epoch),
        ];
        if (this.#loadOptions.config === true) reads.push(this.refreshConfig(epoch));
        await Promise.all(reads);
        if (this.#current(epoch)) {
            this.#replaceSubscriptions(this.#state.instances.map(({ name }) => name), epoch);
        }
    }

    async refreshConfig(epoch = this.#epoch): Promise<void> {
        await this.#readGlobal(
            "config",
            this.#clients.config.get(),
            (value) => { this.#state.configView = value; },
            epoch,
            true,
        );
    }

    async refreshMcp(epoch = this.#epoch): Promise<void> {
        await this.#readGlobal(
            "mcp",
            this.#clients.mcp.status(),
            (value) => { this.#state.mcpStatus = value; },
            epoch,
        );
        if (!this.#current(epoch)) return;
        await this.refreshOAuth(epoch);
    }

    async refreshOAuth(epoch = this.#epoch): Promise<void> {
        const status = this.#state.mcpStatus;
        if (status?.authMode !== "oauth2" || status.oauthReady !== true || status.running !== true) {
            this.#state.oauthApprovals = [];
            this.#clearFailure("oauthApprovals");
            this.#emit();
            return;
        }
        await this.#readGlobal(
            "oauthApprovals",
            this.#clients.mcp.listApprovals(),
            (value) => { this.#state.oauthApprovals = this.#filterOAuthApprovals(value); },
            epoch,
        );
    }

    async refreshOverview(epoch = this.#epoch): Promise<void> {
        await this.#readGlobal(
            "overview",
            this.#clients.overview.get(),
            (value) => { this.#state.overview = value; },
            epoch,
            true,
        );
    }

    async refreshArtifacts(epoch = this.#epoch): Promise<void> {
        const version = this.#nextVersion("artifacts");
        try {
            const [shares, transfers] = await this.#request(
                Promise.all([
                    this.#clients.artifact.listShares(),
                    this.#clients.artifact.listTransfers(),
                ]),
                "artifact.list",
            );
            if (!this.#valid("artifacts", version, epoch)) return;
            this.#state.artifactShares = [...shares].sort(
                (left, right) => right.expiresAtMs - left.expiresAtMs,
            );
            this.#state.artifactTransfers = [...transfers].sort(
                (left, right) => right.createdAt.localeCompare(left.createdAt),
            );
            this.#clearFailure("artifacts");
            this.#emit();
        } catch (error) {
            if (!this.#valid("artifacts", version, epoch)) return;
            if (methodNotFound(error)) {
                this.#state.artifactShares = [];
                this.#state.artifactTransfers = [];
                this.#clearFailure("artifacts");
                this.#emit();
                return;
            }
            this.#setFailure("artifacts", error);
        }
    }

    async refreshContexts(epoch = this.#epoch): Promise<void> {
        const version = this.#nextVersion("contexts");
        try {
            const contexts = await this.#request(
                this.#clients.context.list(),
                "context.list",
            );
            if (!this.#valid("contexts", version, epoch)) return;
            this.#state.contexts = [...contexts].sort((left, right) =>
                left.createdAt.localeCompare(right.createdAt),
            );
            this.#clearFailure("contexts");
            this.#emit();
        } catch (error) {
            if (!this.#valid("contexts", version, epoch)) return;
            if (methodNotFound(error)) {
                this.#state.contexts = [];
                this.#clearFailure("contexts");
                this.#emit();
                return;
            }
            this.#setFailure("contexts", error);
        }
    }

    async refreshInstance(
        instance: string,
        keys: readonly ControlInstanceReadKey[] = instanceKeys,
        todoTitle?: string,
        epoch = this.#epoch,
    ): Promise<number | undefined> {
        await Promise.all(keys.map(async (key) => {
            await this.#refreshInstanceKey(instance, key, todoTitle, epoch);
        }));
        return this.#current(epoch)
            ? this.#state.instanceState[instance]?.sequence
            : undefined;
    }

    async refreshAllInstanceLogs(): Promise<void> {
        await Promise.all(this.#state.instances.map(async ({ name }) => {
            await this.refreshInstance(name, ["logs"]);
        }));
    }

    ensureInstanceSubscription(instance: string): void {
        const state = this.#state.instanceState[instance];
        if (
            state !== undefined &&
            this.#state.instances.some((entry) => entry.name === instance) &&
            !this.#streams.has(instance) &&
            !this.#streamRetries.has(instance)
        ) void this.#startSubscription(instance, state.sequence, this.#epoch);
    }

    applyAuthoritativeSnapshot(snapshot: InstanceSnapshot): void {
        this.#nextVersion(this.#instanceVersionKey(snapshot.name, "snapshot"));
        this.#authoritativeSnapshots.set(snapshot.name, snapshot);
        const state = this.#instance(snapshot.name);
        state.snapshot = snapshot;
        state.sequence = Math.max(state.sequence, snapshot.lastSeq, 1);
        this.#state.instances = this.#state.instances.map((entry) =>
            entry.name === snapshot.name ? { ...entry, snapshot } : entry
        );
        this.#clearFailure(this.failureKey(snapshot.name, "snapshot"));
        this.#emit();
    }

    recordToolDecision(instance: string, approvalId: string): void {
        const ids = this.#decidedToolApprovals.get(instance) ?? new Set<string>();
        ids.add(approvalId);
        this.#decidedToolApprovals.set(instance, ids);
        const state = this.#instance(instance);
        state.approvals = state.approvals.filter((approval) => approval.approvalId !== approvalId);
        this.#emit();
    }

    recordOAuthDecision(approvalId: string): void {
        this.#decidedOAuthApprovals.add(approvalId);
        this.#state.oauthApprovals = this.#state.oauthApprovals.filter(
            (approval) => approval.approvalId !== approvalId,
        );
        this.#emit();
    }

    mergeQueuedContextMessage(instance: string, message: ContextMessageRecord): void {
        const state = this.#instance(instance);
        state.contextMessages = mergeContextMessage(state.contextMessages, message);
        this.#clearFailure(this.failureKey(instance, "comments"));
        this.#emit();
    }

    reset(): void {
        this.#epoch += 1;
        for (const timer of this.#refreshTimers.values()) clearTimeout(timer);
        this.#refreshTimers.clear();
        this.#pendingKeys.clear();
        this.#versions.clear();
        this.#authoritativeSnapshots.clear();
        this.#decidedToolApprovals.clear();
        this.#decidedOAuthApprovals.clear();
        this.#closeSubscriptions();
        this.#state = createInitialControlReadModelState();
        this.#emit();
    }

    close(): void {
        this.reset();
        this.#listeners.clear();
    }

    failureKey(instance: string, key: ControlInstanceReadKey | "stream"): string {
        return `${key}:${instance}`;
    }

    #handleEvent(event: InstanceEvent, epoch: number): void {
        if (!this.#current(epoch)) return;
        const state = this.#instance(event.instanceName);
        state.sequence = Math.max(state.sequence, event.seq, 1);
        if (state.snapshot !== undefined) {
            state.snapshot = { ...state.snapshot, lastSeq: state.sequence };
        }
        const keys = keysForEvent(event);
        if (keys.length > 0) this.#scheduleRefresh(event.instanceName, keys, epoch);
        if (
            event.type.startsWith("artifact.share") ||
            event.type.startsWith("artifact.transfer")
        ) void this.refreshArtifacts(epoch);
        this.#onEvent?.(event);
        this.#emit();
    }

    #scheduleRefresh(
        instance: string,
        keys: readonly ControlInstanceReadKey[],
        epoch: number,
    ): void {
        const pending = this.#pendingKeys.get(instance) ?? new Set<ControlInstanceReadKey>();
        for (const key of keys) pending.add(key);
        this.#pendingKeys.set(instance, pending);
        if (this.#refreshTimers.has(instance)) return;
        const timer = setTimeout(() => {
            this.#refreshTimers.delete(instance);
            const selected = [...(this.#pendingKeys.get(instance) ?? [])];
            this.#pendingKeys.delete(instance);
            if (selected.length > 0 && this.#current(epoch)) {
                void this.refreshInstance(instance, selected, undefined, epoch);
            }
        }, this.#scheduleDelayMs);
        this.#refreshTimers.set(instance, timer);
    }

    async #refreshInstanceKey(
        instance: string,
        key: ControlInstanceReadKey,
        todoTitle: string | undefined,
        epoch: number,
    ): Promise<void> {
        const versionKey = this.#instanceVersionKey(instance, key);
        const version = this.#nextVersion(versionKey);
        try {
            const value = await this.#request(this.#readInstanceKey(instance, key, todoTitle), `${key}:${instance}`);
            if (!this.#valid(versionKey, version, epoch)) return;
            this.#applyInstanceValue(instance, key, value);
            this.#clearFailure(this.failureKey(instance, key));
            this.#emit();
        } catch (error) {
            if (!this.#valid(versionKey, version, epoch)) return;
            if (key === "comments" && methodNotFound(error)) {
                this.#applyInstanceValue(instance, key, { commentCalls: [], contextMessages: [] });
                this.#clearFailure(this.failureKey(instance, key));
                this.#emit();
                return;
            }
            this.#setFailure(this.failureKey(instance, key), error);
        }
    }

    async #readInstanceKey(
        instance: string,
        key: ControlInstanceReadKey,
        todoTitle?: string,
    ): Promise<InstanceReadValue> {
        switch (key) {
            case "snapshot": {
                const envelope = await this.#clients.runtime.refresh(instance);
                return { sequence: envelope.lastSeq, snapshot: envelope.snapshot };
            }
            case "logs":
                return (await this.#clients.runtime.readLogs(instance, { limit: 100 })).slice(-100);
            case "approvals":
                return await this.#clients.tool.listApprovals(instance);
            case "todo":
                return (await this.#clients.todo.get(instance, todoTitle)).todo;
            case "toolCalls":
                return await this.#clients.tool.listCalls(instance, { limit: 200 });
            case "comments": {
                const contextMessages = await this.#clients.contextMessage.list(instance);
                const callIds = [...new Set(contextMessages.flatMap((message) =>
                    message.status === "delivered" && message.callId !== undefined
                        ? [message.callId]
                        : [],
                ))];
                return {
                    commentCalls: callIds.length === 0
                        ? []
                        : await this.#clients.tool.listCalls(instance, { callIds, limit: 1_000 }),
                    contextMessages,
                };
            }
        }
    }

    #applyInstanceValue(
        instance: string,
        key: ControlInstanceReadKey,
        value: InstanceReadValue,
    ): void {
        const state = this.#instance(instance);
        switch (key) {
            case "snapshot": {
                const read = value as { sequence: number; snapshot: InstanceSnapshot };
                const snapshot = this.#resolveSnapshot(instance, read.snapshot);
                state.snapshot = snapshot;
                state.sequence = Math.max(state.sequence, read.sequence, snapshot.lastSeq, 1);
                return;
            }
            case "logs":
                state.logs = value as InstanceLogEntry[];
                return;
            case "approvals":
                state.approvals = this.#filterToolApprovals(instance, value as ApprovalRequest[]);
                return;
            case "todo":
                state.todo = value as TodoReadResult;
                return;
            case "toolCalls":
                state.toolCalls = value as ToolCallRecord[];
                return;
            case "comments": {
                const comments = value as {
                    commentCalls: ToolCallRecord[];
                    contextMessages: ContextMessageRecord[];
                };
                state.commentCalls = comments.commentCalls;
                state.contextMessages = mergeContextMessageList(
                    state.contextMessages,
                    comments.contextMessages,
                );
                return;
            }
        }
    }

    #resolveSnapshot(instance: string, snapshot: InstanceSnapshot): InstanceSnapshot {
        const fence = this.#authoritativeSnapshots.get(instance);
        if (fence === undefined) return snapshot;
        if (snapshot.lastSeq < fence.lastSeq) return fence;
        if (snapshot.lastSeq === fence.lastSeq) {
            return {
                ...snapshot,
                connectionState: fence.connectionState,
                daemonState: fence.daemonState,
                ready: fence.ready,
                status: fence.status,
            };
        }
        this.#authoritativeSnapshots.delete(instance);
        return snapshot;
    }

    #applyInstances(instances: InstanceListEntry[]): void {
        const names = new Set(instances.map(({ name }) => name));
        this.#state.instances = instances.map((entry) => {
            const state = this.#instance(entry.name);
            const incoming = this.#resolveSnapshot(entry.name, entry.snapshot);
            const snapshot = state.snapshot === undefined || incoming.lastSeq >= state.snapshot.lastSeq
                ? incoming
                : state.snapshot;
            if (state.snapshot !== snapshot) {
                state.snapshot = snapshot;
            }
            state.sequence = Math.max(state.sequence, snapshot.lastSeq, 1);
            return entry.snapshot === snapshot ? entry : { ...entry, snapshot };
        });
        for (const name of Object.keys(this.#state.instanceState)) {
            if (!names.has(name)) {
                delete this.#state.instanceState[name];
                this.#closeSubscription(name);
            }
        }
    }

    async #readGlobal<T>(
        key: string,
        request: Promise<T>,
        apply: (value: T) => void,
        epoch: number,
        optional = false,
    ): Promise<void> {
        const version = this.#nextVersion(key);
        try {
            const value = await this.#request(request, key);
            if (!this.#valid(key, version, epoch)) return;
            apply(value);
            this.#clearFailure(key);
            this.#emit();
        } catch (error) {
            if (!this.#valid(key, version, epoch)) return;
            if (optional && methodNotFound(error)) {
                this.#clearFailure(key);
                this.#emit();
                return;
            }
            this.#setFailure(key, error);
        }
    }

    #replaceSubscriptions(instances: readonly string[], epoch: number): void {
        const names = new Set(instances);
        for (const name of new Set([...this.#streams.keys(), ...this.#streamRetries.keys()])) {
            if (!names.has(name)) this.#closeSubscription(name);
        }
        for (const name of instances) {
            const fromSeq = Math.max(1, this.#instance(name).sequence);
            if (!this.#streams.has(name) && !this.#streamRetries.has(name)) {
                void this.#startSubscription(name, fromSeq, epoch);
            }
        }
    }

    async #startSubscription(instance: string, fromSeq: number, epoch: number): Promise<void> {
        if (!this.#current(epoch)) return;
        const token = (this.#streamTokens.get(instance) ?? 0) + 1;
        this.#streamTokens.set(instance, token);
        this.#closeSubscription(instance, false);
        const request = this.#clients.runtime.subscribe(instance, fromSeq);
        let abandoned = false;
        void request.then(
            (stream) => { if (abandoned) stream.close(); },
            () => undefined,
        );
        try {
            const stream = await this.#request(
                request,
                `runtime.subscribe:${instance}`,
            );
            if (!this.#current(epoch) || this.#streamTokens.get(instance) !== token) {
                stream.close();
                return;
            }
            this.#streams.set(instance, stream);
            this.#clearFailure(this.failureKey(instance, "stream"));
            this.#armStable(instance, stream);
            this.#emit();
            void this.#consume(instance, stream, fromSeq, epoch, token);
        } catch (error) {
            abandoned = true;
            if (!this.#current(epoch) || this.#streamTokens.get(instance) !== token) return;
            this.#setFailure(this.failureKey(instance, "stream"), error);
            this.#scheduleSubscription(instance, epoch);
        }
    }

    async #consume(
        instance: string,
        stream: InstanceEventStreamPort,
        fromSeq: number,
        epoch: number,
        token: number,
    ): Promise<void> {
        while (this.#currentStream(instance, stream, epoch, token)) {
            try {
                const message = await stream.next();
                if (!this.#currentStream(instance, stream, epoch, token)) return;
                if (message.kind === "event") {
                    this.#markStable(instance);
                    this.#handleEvent(message.event, epoch);
                    continue;
                }
                this.#closeSubscription(instance, false);
                if (message.kind === "gap") {
                    await this.#recoverGap(instance, message, fromSeq, epoch);
                } else {
                    this.#setFailure(
                        this.failureKey(instance, "stream"),
                        message.error ?? new Error("Subscription closed."),
                    );
                    this.#scheduleSubscription(instance, epoch);
                }
                return;
            } catch (error) {
                if (!this.#current(epoch)) return;
                this.#closeSubscription(instance, false);
                this.#setFailure(this.failureKey(instance, "stream"), error);
                this.#scheduleSubscription(instance, epoch);
                return;
            }
        }
    }

    async #recoverGap(
        instance: string,
        _message: Extract<InstanceStreamMessage, { kind: "gap" }>,
        fromSeq: number,
        epoch: number,
    ): Promise<void> {
        const next = await this.refreshInstance(instance, instanceKeys, undefined, epoch);
        if (!this.#current(epoch)) return;
        if (next === undefined || next <= fromSeq) {
            this.#setFailure(
                this.failureKey(instance, "stream"),
                new Error(`Subscription gap did not advance beyond sequence ${fromSeq}.`),
            );
            this.#scheduleSubscription(instance, epoch);
            return;
        }
        const streak = (this.#gapStreaks.get(instance) ?? 0) + 1;
        this.#gapStreaks.set(instance, streak);
        if (streak === 1) {
            await this.#startSubscription(instance, next, epoch);
            return;
        }
        this.#setFailure(
            this.failureKey(instance, "stream"),
            new Error(`Subscription produced ${streak} consecutive gaps.`),
        );
        this.#scheduleSubscription(instance, epoch);
    }

    #scheduleSubscription(instance: string, epoch: number): void {
        if (!this.#current(epoch) || this.#streamRetries.has(instance)) return;
        const attempt = this.#streamAttempts.get(instance) ?? 0;
        this.#streamAttempts.set(instance, attempt + 1);
        const delay = Math.min(this.#retryBaseMs * 2 ** attempt, 30_000);
        const timer = setTimeout(() => {
            this.#streamRetries.delete(instance);
            if (this.#current(epoch) && this.#state.instanceState[instance] !== undefined) {
                void this.#startSubscription(instance, this.#instance(instance).sequence, epoch);
            }
        }, delay);
        this.#streamRetries.set(instance, timer);
    }

    #armStable(instance: string, stream: InstanceEventStreamPort): void {
        this.#clearStable(instance);
        const timer = setTimeout(() => {
            this.#streamStableTimers.delete(instance);
            if (this.#streams.get(instance) === stream) this.#markStable(instance);
        }, this.#stableAfterMs);
        this.#streamStableTimers.set(instance, timer);
    }

    #markStable(instance: string): void {
        this.#streamAttempts.delete(instance);
        this.#gapStreaks.delete(instance);
        this.#clearStable(instance);
    }

    #closeSubscription(instance: string, invalidate = true): void {
        if (invalidate) this.#streamTokens.set(instance, (this.#streamTokens.get(instance) ?? 0) + 1);
        const stream = this.#streams.get(instance);
        this.#streams.delete(instance);
        stream?.close();
        const retry = this.#streamRetries.get(instance);
        if (retry !== undefined) clearTimeout(retry);
        this.#streamRetries.delete(instance);
        this.#clearStable(instance);
    }

    #closeSubscriptions(): void {
        for (const name of new Set([...this.#streams.keys(), ...this.#streamRetries.keys()])) {
            this.#closeSubscription(name);
        }
        this.#streamTokens.clear();
        this.#streamAttempts.clear();
        this.#gapStreaks.clear();
    }

    #clearStable(instance: string): void {
        const timer = this.#streamStableTimers.get(instance);
        if (timer !== undefined) clearTimeout(timer);
        this.#streamStableTimers.delete(instance);
    }

    #currentStream(
        instance: string,
        stream: InstanceEventStreamPort,
        epoch: number,
        token: number,
    ): boolean {
        return this.#current(epoch) &&
            this.#streamTokens.get(instance) === token &&
            this.#streams.get(instance) === stream;
    }

    #filterToolApprovals(instance: string, approvals: ApprovalRequest[]): ApprovalRequest[] {
        const ids = this.#decidedToolApprovals.get(instance);
        if (ids === undefined) return approvals;
        for (const id of [...ids]) {
            const current = approvals.find((approval) => approval.approvalId === id);
            if (current === undefined || current.status !== "pending") ids.delete(id);
        }
        if (ids.size === 0) this.#decidedToolApprovals.delete(instance);
        return approvals.filter((approval) => approval.status !== "pending" || !ids.has(approval.approvalId));
    }

    #filterOAuthApprovals(approvals: OAuthApprovalRequest[]): OAuthApprovalRequest[] {
        for (const id of [...this.#decidedOAuthApprovals]) {
            const current = approvals.find((approval) => approval.approvalId === id);
            if (current === undefined || current.status !== "pending") this.#decidedOAuthApprovals.delete(id);
        }
        return approvals.filter(
            (approval) => approval.status !== "pending" || !this.#decidedOAuthApprovals.has(approval.approvalId),
        );
    }

    #instance(name: string): ControlInstanceReadState {
        return this.#state.instanceState[name] ??= {
            approvals: [],
            commentCalls: [],
            contextMessages: [],
            logs: [],
            sequence: 1,
            toolCalls: [],
        };
    }

    #setFailure(id: string, error: unknown): void {
        const separator = id.indexOf(":");
        const key = (separator < 0 ? id : id.slice(0, separator)) as ControlReadFailure["key"];
        this.#state.failures[id] = {
            error: error instanceof Error ? error : new Error(String(error)),
            id,
            ...(separator < 0 ? {} : { instance: id.slice(separator + 1) }),
            key,
        };
        this.#emit();
    }

    #clearFailure(key: string): void {
        delete this.#state.failures[key];
    }

    #instanceVersionKey(instance: string, key: ControlInstanceReadKey): string {
        return `${key}:${instance}`;
    }

    #nextVersion(key: string): number {
        const version = (this.#versions.get(key) ?? 0) + 1;
        this.#versions.set(key, version);
        return version;
    }

    #valid(key: string, version: number, epoch: number): boolean {
        return this.#current(epoch) && this.#versions.get(key) === version;
    }

    #current(epoch: number): boolean {
        return this.#epoch === epoch;
    }

    async #request<T>(request: Promise<T>, label: string): Promise<T> {
        return await withRequestTimeout(request, this.#requestTimeoutMs, label);
    }

    #emit(): void {
        this.#state = snapshotState(this.#state);
        for (const listener of this.#listeners) listener();
    }
}

export function createInitialControlReadModelState(): ControlReadModelState {
    return {
        artifactShares: [],
        artifactTransfers: [],
        contexts: [],
        failures: {},
        instances: [],
        instanceState: {},
        oauthApprovals: [],
    };
}

function snapshotState(state: ControlReadModelState): ControlReadModelState {
    return {
        ...state,
        artifactShares: [...state.artifactShares],
        artifactTransfers: [...state.artifactTransfers],
        contexts: [...state.contexts],
        failures: { ...state.failures },
        instances: [...state.instances],
        instanceState: Object.fromEntries(
            Object.entries(state.instanceState).map(([name, value]) => [name, {
                ...value,
                approvals: [...value.approvals],
                commentCalls: [...value.commentCalls],
                contextMessages: [...value.contextMessages],
                logs: [...value.logs],
                toolCalls: [...value.toolCalls],
            }]),
        ),
        oauthApprovals: [...state.oauthApprovals],
    };
}

function keysForEvent(event: InstanceEvent): ControlInstanceReadKey[] {
    const keys: ControlInstanceReadKey[] = [];
    if (event.type.startsWith("instance.")) keys.push("snapshot");
    if (event.type === "log.appended") keys.push("logs");
    if (event.type.startsWith("approval.")) keys.push("approvals");
    if (event.type.startsWith("todo.")) keys.push("todo");
    if (event.type.startsWith("toolCall.")) keys.push("toolCalls", "comments");
    if (event.type.startsWith("context.message.")) keys.push("comments");
    return keys;
}

function mergeContextMessage(
    current: readonly ContextMessageRecord[],
    incoming: ContextMessageRecord,
): ContextMessageRecord[] {
    const existing = current.find((message) => message.id === incoming.id);
    const resolved = existing === undefined || statusRank(incoming.status) >= statusRank(existing.status)
        ? incoming
        : existing;
    return [...current.filter((message) => message.id !== incoming.id), resolved]
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function mergeContextMessageList(
    current: readonly ContextMessageRecord[],
    incoming: readonly ContextMessageRecord[],
): ContextMessageRecord[] {
    let result = [...current];
    for (const message of incoming) result = mergeContextMessage(result, message);
    const incomingIds = new Set(incoming.map((message) => message.id));
    return result.filter(
        (message) => incomingIds.has(message.id) || message.status === "pending" || message.status === "sent",
    );
}

function statusRank(status: ContextMessageRecord["status"]): number {
    switch (status) {
        case "pending": return 0;
        case "sent": return 1;
        case "delivered": return 2;
        case "failed": return 2;
    }
}

function methodNotFound(error: unknown): boolean {
    return typeof error === "object" && error !== null &&
        "code" in error && error.code === "control.methodNotFound";
}
