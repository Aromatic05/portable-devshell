import {
    useEffect,
    useMemo,
    useState,
    useSyncExternalStore,
} from "react";

import {
    compactContextId,
    type ApprovalRequest,
    type ArtifactStoredImageResult,
    type InstanceListEntry,
    type McpContextRecord,
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
    const [filters, setFilters] = useState<Filters>(emptyToolCallFilters);
    const [contextStatus, setContextStatus] =
        useState<AuditContextStatusFilter>("active");
    const [toolCallPage, setToolCallPage] = useState(0);
    const [batchDisableOpen, setBatchDisableOpen] = useState(false);
    const [refreshing, setRefreshing] = useState(false);
    const allCalls = useMemo(
        () =>
            Object.values(toolCallsState.instances).flatMap(
                (value) => value.calls,
            ),
        [toolCallsState],
    );
    const scope = auditScope(route);
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
                allCalls,
                contextStatus,
                now,
                scope,
            ),
        [
            allCalls,
            contextState.contexts,
            contextStatus,
            instancesState.instances,
            now,
            scope,
        ],
    );
    const scopedCalls = useMemo(
        () => calls.filter((call) => callMatchesScope(call, scope)),
        [calls, scope],
    );
    const tools = useMemo(
        () => [...new Set(scopedCalls.map((call) => call.toolName))].sort(),
        [scopedCalls],
    );
    const selection = useMemo(() => {
        if (route.view === "call") {
            const call = scopedCalls.find(
                (candidate) => candidate.callId === route.callId,
            );
            return {
                items: call === undefined ? [] : [call],
                total: call === undefined ? 0 : 1,
            };
        }
        return selectToolCalls(
            scopedCalls,
            filters,
            now,
            toolCallPage * toolCallPageSize,
            toolCallPageSize,
        );
    }, [filters, now, route, scopedCalls, toolCallPage]);
    const active = contextStatus !== "all" || hasActiveToolCallFilters(filters);
    const interactive = server.status === "online" && !disabled;
    const countText =
        route.view === "call"
            ? selection.total === 0
                ? "Tool call not found in the current read model."
                : "Tool call detail."
            : selection.total === 0
              ? `0 of ${scopedCalls.length} tool calls${active ? " match active filters." : "."}`
              : `Showing ${toolCallPage * toolCallPageSize + 1}-${toolCallPage * toolCallPageSize + selection.items.length} of ${selection.total} matching tool calls.`;

    useEffect(() => {
        if (server.status !== "online") return;
        void store.refreshAudit();
    }, [server.status, store]);

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
        setRefreshing(true);
        try {
            await store.refreshAudit();
        } finally {
            setRefreshing(false);
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
            <p aria-live="polite" className="hint">
                {countText}
            </p>
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
            ) : selection.items.length === 0 ? (
                <p className="empty">
                    {route.view === "call"
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
                            key={`${call.instance}-${call.callId}`}
                            now={now}
                            onDecideApproval={async (approval, decision) => {
                                const succeeded = await store.decideTool(
                                    approval.instance,
                                    approval.approvalId,
                                    decision,
                                );
                                if (!succeeded) {
                                    throw new Error(
                                        storeState.error ??
                                            "Approval could not be recorded.",
                                    );
                                }
                            }}
                            onLoadDetail={async () =>
                                (
                                    await domains.toolCalls.readDetail(
                                        call.instance,
                                        call.callId,
                                    )
                                )[0]
                            }
                            onLoadImage={domains.artifactTransport.readImage}
                            onRefresh={async () =>
                                await store.refreshToolCall(call.instance)
                            }
                        />
                    ))}
                </ol>
            )}
            {route.view === "timeline" ? (
                <Pagination
                    label="Tool calls"
                    onPageChange={setToolCallPage}
                    page={toolCallPage}
                    pageCount={pageCount(selection.total, toolCallPageSize)}
                />
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
    onDecideApproval,
    onLoadDetail,
    onLoadImage,
    onRefresh,
}: {
    call: ToolCallRecord;
    disabled: boolean;
    domains: WebDomainSession;
    initiallyOpen: boolean;
    now: number;
    onDecideApproval(
        approval: ApprovalRequest,
        decision: "approve" | "deny",
    ): Promise<void>;
    onLoadDetail(): Promise<ToolCallRecord | undefined>;
    onLoadImage(imageRef: string): Promise<ArtifactStoredImageResult>;
    onRefresh(): Promise<void>;
}) {
    const runtimeState = useDomainSnapshot(domains.runtime(call.instance));
    const approvalState = useDomainSnapshot(domains.approval(call.instance));
    const approval = approvalState.approvals.find(
        (candidate) => candidate.callId === call.callId,
    );
    return (
        <ToolCallEntry
            approval={approval}
            call={call}
            disabled={disabled}
            initiallyOpen={initiallyOpen}
            logs={runtimeState.logs}
            now={now}
            onDecideApproval={onDecideApproval}
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
    contexts: readonly McpContextRecord[],
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
            record?: McpContextRecord;
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
    contextRecords: ReadonlyMap<string, McpContextRecord>,
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
    context: McpContextRecord | undefined,
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
