import {
    useEffect,
    useMemo,
    useRef,
    useState,
    useSyncExternalStore,
} from "react";

import {
    compactContextId,
    type ApprovalRequest,
    type ArtifactImageContent,
    type InstanceListEntry,
    type ContextRecord,
    type ToolCallRecord,
} from "@portable-devshell/shared";

import { workspaceFolderName } from "../../../Presentation.js";
import { ContextBatchDisableDialog, ContextIntervention } from "./Context.js";
import {
    AuditFilters,
    type AuditContextStatusFilter,
    type AuditScopeOption,
} from "./tool/Filters.js";
import { ToolCallEntry } from "./tool/Entry.js";
import { approvalMatchesFilters, useApprovalSnapshots } from "./approval/Snapshots.js";
import { ApprovalActions, ApprovalReview, type ApprovalReviewSelection } from "./approval/Review.js";
import type { AuditScope, WebRoute } from "../../../../app/Route.js";
import {
    useDomainSnapshot,
    useWebDomains,
} from "../../../../app/domain/Context.js";
import type { WebDomainSession } from "../../../../app/domain/Session.js";
import {
    emptyToolCallFilters,
    hasActiveToolCallFilters,
    selectToolCalls,
    type ToolCallFilters as Filters,
} from "./tool/Model.js";
import type { WebStore } from "../../../../state/Store.js";
import { approvalOperationKey } from "../../../../state/Operation.js";
import { useNow } from "../../../Clock.js";

const toolCallPageSize = 20;
const activeContextWindowMs = 30 * 60 * 1_000;

export function Audit({
    disabled = false,
    navigate,
    route,
    store,
}: {
    disabled?: boolean;
    navigate(route: WebRoute): void;
    route: Extract<WebRoute, { page: "audit" }>;
    store: WebStore;
}) {
    const domains = useWebDomains();
    const now = useNow();
    const server = useDomainSnapshot(domains.server);
    const instancesState = useDomainSnapshot(domains.instances);
    const contextState = useDomainSnapshot(domains.context);
    const toolCallsState = useDomainSnapshot(domains.toolCalls);
    const storeState = useSyncExternalStore(
        store.subscribe,
        () => store.state,
        () => store.state,
    );
    const approvalSnapshots = useApprovalSnapshots(domains, instancesState.instances, server.status === "online");
    const allApprovals = approvalSnapshots.approvals;
    const [review, setReview] = useState<ApprovalReviewSelection>();
    const routeKey = JSON.stringify(route);
    const routeEpoch = useRef(0);
    useEffect(() => { setReview(undefined); }, [routeKey]);
    useEffect(() => {
        if (review === undefined) return;
        const selected = review.approval;
        const replaced = allApprovals.some((approval) => approval.instance === selected.instance &&
            approval.callId === selected.callId && approval.approvalId !== selected.approvalId);
        if (replaced || !instancesState.instances.some(({ name }) => name === selected.instance)) setReview(undefined);
    }, [allApprovals, instancesState.instances, review]);
    const [filters, setFilters] = useState<Filters>(emptyToolCallFilters);
    const [contextStatus, setContextStatus] =
        useState<AuditContextStatusFilter>("all");
    const [toolCallPage, setToolCallPage] = useState(0);
    const [batchDisableOpen, setBatchDisableOpen] = useState(false);
    const [refreshing, setRefreshing] = useState(false);
    useEffect(() => {
        routeEpoch.current += 1;
        setRefreshing(false);
        return () => { routeEpoch.current += 1; };
    }, [routeKey]);
    const [loadingOlder, setLoadingOlder] = useState(false);
    const [olderError, setOlderError] = useState<string>();
    const olderRequest = useRef(0);
    useEffect(() => {
        olderRequest.current += 1;
        setLoadingOlder(false);
        setOlderError(undefined);
        setToolCallPage(0);
    }, [routeKey]);
    const [detailRetry, setDetailRetry] = useState(0);
    const [directCall, setDirectCall] = useState<{
        key: string;
        call?: ToolCallRecord;
        error?: string;
        loading?: boolean;
    }>();
    const allCalls = useMemo(
        () =>
            Object.values(toolCallsState.instances).flatMap(
                (value) => value.calls,
            ),
        [toolCallsState],
    );
    const scope = auditScope(route);
    const contextInstance = route.view === "timeline" && scope.kind === "context"
        ? scope.instance : undefined;
    const contextId = route.view === "timeline" && scope.kind === "context"
        ? scope.ctxId : undefined;
    const contextHistory = scope.kind === "context" &&
        toolCallsState.context?.instance === contextInstance &&
        toolCallsState.context?.ctxId === contextId ? toolCallsState.context : undefined;
    useEffect(() => {
        if (server.status !== "online" || contextInstance === undefined || contextId === undefined) return;
        void domains.toolCalls.loadContext(contextInstance, contextId);
        return () => domains.toolCalls.clearContext(contextInstance, contextId);
    }, [domains, server.status, contextInstance, contextId]);
    const scopedInstanceNames = scope.kind === "all"
        ? instancesState.instances.map((entry) => entry.name)
        : [scope.instance];
    const failingInstances = (scope.kind === "context" ? [] : scopedInstanceNames).filter((instance) =>
        toolCallsState.instances[instance]?.failure !== undefined);
    const historyInstances = (scope.kind === "context" ? [] : scopedInstanceNames).filter((instance) => {
        const ledger = toolCallsState.instances[instance];
        return ledger?.historyBefore !== undefined && ledger.historyExhausted !== true;
    });
    const contextHasOlder = contextHistory?.historyBefore !== undefined &&
        contextHistory.historyExhausted !== true;
    const inMemoryCall = route.view === "call" ? allCalls.find((call) =>
        call.instance === route.instance && call.callId === route.callId &&
        (route.ctxId === undefined || call.ctxId === route.ctxId)) : undefined;
    useEffect(() => {
        if (route.view !== "call" || inMemoryCall !== undefined) return;
        let active = true;
        setDirectCall({ key: routeKey, loading: true });
        void domains.toolCalls.readDetail(route.instance, route.callId).then((rows) => {
            if (!active) return;
            setDirectCall({
                key: routeKey,
                call: rows.find((call) => call.instance === route.instance &&
                    call.callId === route.callId &&
                    (route.ctxId === undefined || call.ctxId === route.ctxId)),
            });
        }).catch((error: unknown) => {
            if (active) setDirectCall({
                key: routeKey,
                error: error instanceof Error ? error.message : String(error),
            });
        });
        return () => { active = false; };
    }, [domains, routeKey, inMemoryCall?.callId, detailRetry]);
    const contextRecords = useMemo(
        () =>
            new Map(
                contextState.contexts.map((context) => [
                    context.ctxId,
                    context,
                ]),
            ),
        [contextState.contexts],
    );
    const calls = useMemo(
        () =>
            allCalls.filter((call) =>
                callMatchesContextFilter(
                    call,
                    scope,
                    contextRecords,
                    contextStatus,
                    now,
                ),
            ),
        [allCalls, contextRecords, contextStatus, now, scope],
    );
    const scopes = useMemo(
        () =>
            auditScopeOptions(
                instancesState.instances,
                contextState.contexts,
                [...allCalls, ...allApprovals],
                contextStatus,
                now,
                scope,
            ),
        [
            allCalls,
            allApprovals,
            contextState.contexts,
            contextStatus,
            instancesState.instances,
            now,
            scope,
        ],
    );
    const scopedCalls = scope.kind === "context"
        ? (contextHistory?.calls ?? []).filter((call) => callMatchesScope(call, scope))
        : calls.filter((call) => callMatchesScope(call, scope));
    const scopedApprovals = allApprovals.filter((approval) => callMatchesScope(approval, scope) &&
        callMatchesContextFilter(approval, scope, contextRecords, contextStatus, now) &&
        (route.view !== "call" || approval.callId === route.callId));
    const standaloneApprovals = scopedApprovals.filter((approval) =>
        !allCalls.some((call) => call.instance === approval.instance && call.callId === approval.callId) &&
        !scopedCalls.some((call) => call.instance === approval.instance && call.callId === approval.callId) &&
        approvalMatchesFilters(approval, filters, now));
    const tools = [...new Set([...scopedCalls, ...scopedApprovals].map((item) => item.toolName))].sort();
    const filteredSelection = useMemo(() => {
        if (route.view === "call") {
            const call = inMemoryCall ?? (directCall?.key === routeKey ? directCall.call : undefined);
            return {
                items: call === undefined ? [] : [call],
                total: call === undefined ? 0 : 1,
            };
        }
        return selectToolCalls(
            scopedCalls,
            filters,
            now,
            0,
            scopedCalls.length,
        );
    }, [filters, now, route, scopedCalls, inMemoryCall, directCall, routeKey]);
    const currentPage = Math.min(toolCallPage, pageCount(filteredSelection.total, toolCallPageSize) - 1);
    if (currentPage !== toolCallPage) setToolCallPage(currentPage);
    const selection = route.view === "call" ? filteredSelection : {
        total: filteredSelection.total,
        items: filteredSelection.items.slice(currentPage * toolCallPageSize, (currentPage + 1) * toolCallPageSize),
    };
    const active = contextStatus !== "all" || hasActiveToolCallFilters(filters);
    const interactive = server.status === "online" && !disabled;
    const directLoading = route.view === "call" && inMemoryCall === undefined &&
        (directCall?.key !== routeKey || directCall.loading === true);
    const countText =
        route.view === "call"
            ? selection.total === 0
                ? directLoading ? "Loading archived Tool Call…" : "Tool Call not found in the retained audit."
                : "Tool call detail."
            : selection.total === 0
              ? `0 of ${scopedCalls.length} loaded tool calls${active ? " match active filters." : "."}`
              : `Showing ${currentPage * toolCallPageSize + 1}-${currentPage * toolCallPageSize + selection.items.length} of ${selection.total} loaded matching tool calls.`;

    async function loadOlder(): Promise<void> {
        if (!interactive || loadingOlder || (!contextHasOlder && historyInstances.length === 0)) return;
        const request = ++olderRequest.current;
        setLoadingOlder(true);
        setOlderError(undefined);
        try {
            if (scope.kind === "context") {
                await domains.toolCalls.loadOlderContext(scope.instance, scope.ctxId);
                return;
            }
            const results = await Promise.allSettled(historyInstances.map((instance) =>
                domains.toolCalls.loadOlder(instance)));
            const failed = results.map((result, index) => result.status === "rejected"
                ? `${historyInstances[index]}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`
                : undefined).filter((message): message is string => message !== undefined);
            if (failed.length > 0 && request === olderRequest.current)
                setOlderError(failed.join("; "));
        } catch (error) {
            if (request === olderRequest.current)
                setOlderError(error instanceof Error ? error.message : String(error));
        } finally {
            if (request === olderRequest.current) setLoadingOlder(false);
        }
    }

    function changeFilters(next: Filters): void {
        setToolCallPage(0);
        if (
            contextStatus === "active" &&
            filters.ctxId.trim().length === 0 &&
            next.ctxId.trim().length > 0
        ) {
            setContextStatus("all");
        }
        setFilters(next);
    }

    async function refreshAll(): Promise<void> {
        if (!interactive || refreshing) return;
        const epoch = routeEpoch.current;
        setRefreshing(true);
        approvalSnapshots.retry();
        try {
            await store.refreshAudit();
            if (epoch !== routeEpoch.current) return;
            if (route.view === "call") setDetailRetry((value) => value + 1);
            if (route.view === "timeline" && scope.kind === "context")
                await domains.toolCalls.loadContext(scope.instance, scope.ctxId);
        } finally {
            if (epoch === routeEpoch.current) setRefreshing(false);
        }
    }

    return (
        <section className="audit-page">
            <div className="audit-heading">
                <div>
                    <h2>Audit</h2>
                    <p className="hint">{scopeLabel(scope)}</p>
                </div>
                <div className="actions audit-actions">
                    <button
                        disabled={!interactive || refreshing}
                        onClick={() => void refreshAll()}
                        type="button"
                    >
                        {refreshing ? "Refreshing…" : "Refresh all"}
                    </button>
                    <button
                        disabled={!interactive}
                        onClick={() => setBatchDisableOpen(true)}
                        type="button"
                    >
                        Disable inactive Contexts…
                    </button>
                </div>
            </div>
            <AuditFilters
                contextStatus={contextStatus}
                filters={filters}
                onChange={changeFilters}
                onClear={() => {
                    setContextStatus("all");
                    setFilters(emptyToolCallFilters);
                }}
                onContextStatusChange={(nextStatus) => {
                    setToolCallPage(0);
                    setContextStatus(nextStatus);
                }}
                onScopeChange={(nextScope) => {
                    setToolCallPage(0);
                    navigate({
                        page: "audit",
                        view: "timeline",
                        scope: nextScope,
                    });
                }}
                scope={scope}
                scopes={scopes}
                tools={tools}
            />
            {scope.kind === "context" ? (
                <ContextIntervention
                    ctxId={scope.ctxId}
                    disabled={disabled}
                    instance={scope.instance}
                    store={store}
                />
            ) : null}
            {approvalSnapshots.pending.some((instance) => scope.kind === "all" || scope.instance === instance) ? (
                <p role="status">Loading pending approvals…</p>
            ) : null}
            {Object.entries(approvalSnapshots.failures).filter(([instance]) => scope.kind === "all" || scope.instance === instance).map(([instance, failure]) => (
                <div key={instance}>
                    <p className="error" role="alert">Could not load approvals for {instance}: {failure}</p>
                    <button disabled={!interactive || approvalSnapshots.pending.length > 0} onClick={approvalSnapshots.retry} type="button">Retry approvals</button>
                </div>
            ))}
            {standaloneApprovals.length === 0 ? null : (
                <section aria-label="Pending approvals">
                    <h3>Pending approvals</h3>
                    <p className="hint">These requests are awaiting a decision before execution.</p>
                    <ol className="feed activity-feed">
                        {standaloneApprovals.map((approval) => (
                            <li className="activity-record approval-record" key={approvalOperationKey(approval.instance, approval.approvalId)}>
                                <article>
                                    <h4>{approval.toolName} · {approval.instance}</h4>
                                    <p>{approval.ctxId === undefined ? "No Context" : `ctx ${approval.ctxId}`} · {workspaceFolderName(approval.workspace)} · {approval.riskLevel} risk</p>
                                    <p>{approval.reason}</p>
                                    <pre>{approval.inputSummary}</pre>
                                    <ApprovalActions approval={approval} disabled={!interactive}
                                        pending={storeState.operations[approvalOperationKey(approval.instance, approval.approvalId)] === "pending"} onReview={setReview} />
                                </article>
                            </li>
                        ))}
                    </ol>
                </section>
            )}
            {review === undefined ? null : (
                <ApprovalReview key={approvalOperationKey(review.approval.instance, review.approval.approvalId)}
                    selection={review} store={store} onClose={() => setReview(undefined)}
                    available={allApprovals.some((approval) => approval.instance === review.approval.instance && approval.approvalId === review.approval.approvalId)}
                    disabled={!interactive}
                    pending={storeState.operations[approvalOperationKey(review.approval.instance, review.approval.approvalId)] === "pending"} />
            )}
            <p aria-live="polite" className="hint">
                {countText}
            </p>
            {failingInstances.map((instance) => (
                <div key={instance} role="alert">
                    <p className="error">Could not load Tool Calls from {instance}: {toolCallsState.instances[instance]!.failure!.message}</p>
                    <button disabled={!interactive} type="button"
                        onClick={() => void domains.toolCalls.load(instance)}>Retry {instance}</button>
                </div>
            ))}
            {scope.kind === "context" && contextHistory?.failure !== undefined ? (
                <div role="alert">
                    <p className="error">Could not load Context Tool Calls: {contextHistory.failure.message}</p>
                    <button disabled={!interactive} type="button" onClick={() => void domains.toolCalls.loadContext(scope.instance, scope.ctxId)}>Retry Context Audit</button>
                </div>
            ) : null}
            {route.view === "call" && directCall?.key === routeKey && directCall.error !== undefined ? (
                <div role="alert">
                    <p className="error">Could not read Tool Call: {directCall.error}</p>
                    <button disabled={!interactive} type="button" onClick={() => setDetailRetry((value) => value + 1)}>Retry detail</button>
                </div>
            ) : null}
            {batchDisableOpen ? (
                <ContextBatchDisableDialog
                    busy={
                        storeState.operations["context-disable-batch"] !==
                        undefined
                    }
                    contexts={contextState.contexts}
                    disabled={!interactive}
                    now={now}
                    onClose={() => setBatchDisableOpen(false)}
                    onDisable={async (ctxIds) =>
                        await store.disableContexts(ctxIds)
                    }
                />
            ) : null}
            {server.status === "offline" && allCalls.length === 0 ? (
                <p className="empty">
                    Tool calls are unavailable while offline.
                </p>
            ) : server.status === "connecting" && allCalls.length === 0 ? (
                <p className="empty">Loading tool calls…</p>
            ) : route.view === "timeline" && scope.kind === "context" &&
                (contextHistory === undefined || (contextHistory.loading && contextHistory.calls.length === 0)) ? (
                <p className="empty">{server.status === "offline"
                    ? "Context Tool Calls are unavailable while offline."
                    : "Loading Context Tool Calls…"}</p>
            ) : directLoading ? (
                <p className="empty">Loading archived Tool Call…</p>
            ) : selection.items.length === 0 ? (
                <p className="empty">
                    {failingInstances.length > 0 ? "Tool Call history is incomplete until failed reads recover."
                        : route.view === "call"
                        ? "This Tool Call is unavailable."
                        : active
                          ? "No tool calls match these filters."
                          : "No tool calls are available in this scope."}
                </p>
            ) : (
                <ol className="feed activity-feed">
                    {selection.items.map((call) => (
                        <ToolCallActivity
                            call={call}
                            disabled={!interactive}
                            domains={domains}
                            initiallyOpen={
                                route.view === "call" &&
                                call.callId === route.callId
                            }
                            key={JSON.stringify([call.instance, call.callId])}
                            now={now}
                            operations={storeState.operations}
                            approval={allApprovals.find((approval) => approval.instance === call.instance && approval.callId === call.callId)}
                            onReviewApproval={setReview}
                            onLoadDetail={async () =>
                                (
                                    await domains.toolCalls.readDetail(
                                        call.instance,
                                        call.callId,
                                    )
                                )[0]
                            }
                            onLoadImage={domains.artifactTransport.readImage}
                            onRefresh={async () => {
                                const epoch = routeEpoch.current;
                                await store.refreshToolCall(call.instance);
                                if (epoch === routeEpoch.current && route.view === "call" && inMemoryCall === undefined)
                                    setDetailRetry((value) => value + 1);
                            }}
                        />
                    ))}
                </ol>
            )}
            {route.view === "timeline" ? (
                <>
                    <Pagination
                        label="Tool calls"
                        onPageChange={setToolCallPage}
                        page={currentPage}
                        pageCount={pageCount(selection.total, toolCallPageSize)}
                    />
                    {(historyInstances.length > 0 || contextHasOlder) && (
                        <div className="actions">
                            <button disabled={!interactive || loadingOlder} onClick={() => void loadOlder()} type="button">
                                {loadingOlder ? "Loading older Tool Calls…" : "Load older Tool Calls"}
                            </button>
                        </div>
                    )}
                    {olderError !== undefined && <p className="error" role="alert">Older Tool Calls could not be loaded: {olderError}</p>}
                </>
            ) : null}
        </section>
    );
}

function ToolCallActivity({
    call,
    disabled,
    domains,
    initiallyOpen,
    now,
    operations,
    approval,
    onReviewApproval,
    onLoadDetail,
    onLoadImage,
    onRefresh,
}: {
    call: ToolCallRecord;
    disabled: boolean;
    domains: WebDomainSession;
    initiallyOpen: boolean;
    now: number;
    operations: Readonly<Record<string, "pending">>;
    approval?: ApprovalRequest;
    onReviewApproval(selection: ApprovalReviewSelection): void;
    onLoadDetail(): Promise<ToolCallRecord | undefined>;
    onLoadImage(imageRef: string): Promise<ArtifactImageContent>;
    onRefresh(): Promise<void>;
}) {
    const runtimeState = useDomainSnapshot(domains.runtime(call.instance));
    return (
        <ToolCallEntry
            approval={approval}
            approvalPending={approval !== undefined && operations[approvalOperationKey(approval.instance, approval.approvalId)] === "pending"}
            call={call}
            disabled={disabled}
            initiallyOpen={initiallyOpen}
            logs={runtimeState.logs}
            now={now}
            onReviewApproval={onReviewApproval}
            onLoadDetail={onLoadDetail}
            onLoadImage={onLoadImage}
            onRefresh={onRefresh}
        />
    );
}

function auditScope(route: Extract<WebRoute, { page: "audit" }>): AuditScope {
    if (route.view === "timeline") return route.scope;
    return route.ctxId === undefined
        ? { kind: "instance", instance: route.instance }
        : { kind: "context", instance: route.instance, ctxId: route.ctxId };
}

function auditScopeOptions(
    instances: readonly InstanceListEntry[],
    contexts: readonly ContextRecord[],
    calls: readonly { ctxId?: string; instance: string; workspace?: string }[],
    contextStatus: AuditContextStatusFilter,
    now: number,
    currentScope: AuditScope,
): AuditScopeOption[] {
    const instanceNames = new Set(instances.map((instance) => instance.name));
    const contextEntries = new Map<
        string,
        {
            ctxId: string;
            instance: string;
            record?: ContextRecord;
            status?: string;
            workspace?: string;
        }
    >();
    for (const context of contexts) {
        for (const environment of context.environments) {
            instanceNames.add(environment.instance);
            contextEntries.set(`${environment.instance}\u0000${context.ctxId}`, {
                ctxId: context.ctxId,
                instance: environment.instance,
                record: context,
                status: context.status,
                workspace: environment.workspace,
            });
        }
    }
    for (const call of calls) {
        instanceNames.add(call.instance);
        if (call.ctxId !== undefined) {
            const key = `${call.instance}\u0000${call.ctxId}`;
            if (!contextEntries.has(key))
                contextEntries.set(key, {
                    ctxId: call.ctxId,
                    instance: call.instance,
                    workspace: call.workspace,
                });
        }
    }
    return [
        { label: "All instances", scope: { kind: "all" } },
        ...[...instanceNames].sort().map((instance): AuditScopeOption => ({
            group: { id: "instances", label: "Instances" },
            label: instance,
            scope: { kind: "instance", instance },
        })),
        ...[...contextEntries.values()]
            .filter(
                (context) =>
                    (currentScope.kind === "context" &&
                        currentScope.instance === context.instance &&
                        currentScope.ctxId === context.ctxId) ||
                    contextMatchesFilter(context.record, contextStatus, now),
            )
            .sort(
                (left, right) =>
                    (left.workspace ?? "").localeCompare(
                        right.workspace ?? "",
                    ) ||
                    left.instance.localeCompare(right.instance) ||
                    left.ctxId.localeCompare(right.ctxId),
            )
            .map((context): AuditScopeOption => ({
                group:
                    context.workspace === undefined
                        ? { id: "contexts:other", label: "Other Contexts" }
                        : {
                              id: `workspace:${context.workspace}`,
                              label: `Workspace · ${workspaceFolderName(context.workspace)}`,
                          },
                label: `${compactContextId(context.ctxId)} · ${context.instance}${context.status === undefined ? "" : ` · ${context.status}`}`,
                scope: {
                    kind: "context",
                    instance: context.instance,
                    ctxId: context.ctxId,
                },
            })),
    ];
}

function callMatchesContextFilter(
    call: { ctxId?: string; instance: string },
    scope: AuditScope,
    contextRecords: ReadonlyMap<string, ContextRecord>,
    filter: AuditContextStatusFilter,
    now: number,
): boolean {
    if (
        scope.kind === "context" &&
        call.instance === scope.instance &&
        call.ctxId === scope.ctxId
    ) {
        return true;
    }
    return (
        call.ctxId === undefined ||
        contextMatchesFilter(contextRecords.get(call.ctxId), filter, now)
    );
}

function contextMatchesFilter(
    context: ContextRecord | undefined,
    filter: AuditContextStatusFilter,
    now: number,
): boolean {
    if (filter === "all" || context === undefined) return true;
    if (context.status !== filter) return false;
    return (
        filter !== "active" ||
        Date.parse(context.lastAccessedAt) >= now - activeContextWindowMs
    );
}

function callMatchesScope(
    call: { ctxId?: string; instance: string },
    scope: AuditScope,
): boolean {
    if (scope.kind === "all") return true;
    if (call.instance !== scope.instance) return false;
    return scope.kind === "instance" || call.ctxId === scope.ctxId;
}

function scopeLabel(scope: AuditScope): string {
    if (scope.kind === "all") return "All instances";
    if (scope.kind === "instance") return `Instance · ${scope.instance}`;
    return `Context · ${scope.ctxId} · ${scope.instance}`;
}

function Pagination({
    label,
    onPageChange,
    page,
    pageCount,
}: {
    label: string;
    onPageChange(page: number): void;
    page: number;
    pageCount: number;
}) {
    if (pageCount < 2) return null;
    return (
        <nav aria-label={`${label} pagination`} className="pagination">
            <button
                disabled={page === 0}
                onClick={() => onPageChange(page - 1)}
                type="button"
            >
                Previous page
            </button>
            <span aria-live="polite">
                Page {page + 1} of {pageCount}
            </span>
            <button
                disabled={page === pageCount - 1}
                onClick={() => onPageChange(page + 1)}
                type="button"
            >
                Next page
            </button>
        </nav>
    );
}

function pageCount(total: number, size: number): number {
    return Math.max(1, Math.ceil(total / size));
}
