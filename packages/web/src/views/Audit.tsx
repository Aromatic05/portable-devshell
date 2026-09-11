import { useMemo, useState } from "react";

import type { McpContextRecord } from "@portable-devshell/shared/browser";

import { ContextBatchDisableDialog } from "../components/ContextBatchDisableDialog.js";
import { ContextIntervention } from "../components/ContextIntervention.js";
import {
    AuditFilters,
    type AuditContextStatusFilter,
    type AuditScopeOption,
} from "../components/toolcall/AuditFilters.js";
import { ToolCallEntry } from "../components/toolcall/ToolCallEntry.js";
import type { AuditScope, WebRoute } from "../routing/hashRoute.js";
import {
    emptyToolCallFilters,
    hasActiveToolCallFilters,
    selectToolCalls,
    type ToolCallFilters as Filters,
} from "../selectors/toolCalls.js";
import type { WebState, WebStore } from "../state/WebStore.js";

const toolCallPageSize = 20;
const activeContextWindowMs = 30 * 60 * 1_000;

export function Audit({
    disabled = false,
    navigate,
    route,
    state,
    store,
}: {
    disabled?: boolean;
    navigate(route: WebRoute): void;
    route: Extract<WebRoute, { page: "audit" }>;
    state: WebState;
    store: WebStore;
}) {
    const [filters, setFilters] = useState<Filters>(emptyToolCallFilters);
    const [contextStatus, setContextStatus] = useState<AuditContextStatusFilter>("active");
    const [toolCallPage, setToolCallPage] = useState(0);
    const [batchDisableOpen, setBatchDisableOpen] = useState(false);
    const [refreshing, setRefreshing] = useState(false);
    const instanceState = state.readModel.instanceState;
    const allCalls = useMemo(
        () => Object.values(instanceState).flatMap((value) => value.toolCalls),
        [instanceState],
    );
    const scope = auditScope(route);
    const contextRecords = useMemo(
        () => new Map(state.readModel.contexts.map((context) => [context.ctxId, context])),
        [state.readModel.contexts],
    );
    const now = Date.now();
    const calls = useMemo(
        () => allCalls.filter((call) =>
            callMatchesContextFilter(call, scope, contextRecords, contextStatus, now)
        ),
        [allCalls, contextRecords, contextStatus, now, scope],
    );
    const scopes = useMemo(
        () => auditScopeOptions(state, allCalls, contextStatus, now, scope),
        [allCalls, contextStatus, now, scope, state],
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
            const call = scopedCalls.find((candidate) => candidate.callId === route.callId);
            return { items: call === undefined ? [] : [call], total: call === undefined ? 0 : 1 };
        }
        return selectToolCalls(
            scopedCalls,
            filters,
            Date.now(),
            toolCallPage * toolCallPageSize,
            toolCallPageSize,
        );
    }, [filters, route, scopedCalls, toolCallPage]);
    const active = contextStatus !== "all" || hasActiveToolCallFilters(filters);
    const interactive = state.connection === "online" && !disabled;
    const countText = route.view === "call"
        ? selection.total === 0 ? "Tool call not found in the current read model." : "Tool call detail."
        : selection.total === 0
          ? `0 of ${scopedCalls.length} tool calls${active ? " match active filters." : "."}`
          : `Showing ${toolCallPage * toolCallPageSize + 1}-${toolCallPage * toolCallPageSize + selection.items.length} of ${selection.total} matching tool calls.`;

    function changeFilters(next: Filters): void {
        setToolCallPage(0);
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

    return <section className="audit-page">
        <div className="audit-heading">
            <div>
                <h2>Audit</h2>
                <p className="hint">{scopeLabel(scope)}</p>
            </div>
            <div className="actions audit-actions">
                <button disabled={!interactive || refreshing} onClick={() => void refreshAll()} type="button">
                    {refreshing ? "Refreshing…" : "Refresh all"}
                </button>
                <button disabled={!interactive} onClick={() => setBatchDisableOpen(true)} type="button">
                    Manage Contexts
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
                navigate({ page: "audit", view: "timeline", scope: nextScope });
            }}
            scope={scope}
            scopes={scopes}
            tools={tools}
        />
        {scope.kind === "context" ? <ContextIntervention
            ctxId={scope.ctxId}
            disabled={disabled}
            instance={scope.instance}
            state={state}
            store={store}
        /> : null}
        <p aria-live="polite" className="hint">{countText}</p>
        {batchDisableOpen ? <ContextBatchDisableDialog
            busy={state.operations["context-disable-batch"] !== undefined}
            contexts={state.readModel.contexts}
            disabled={!interactive}
            onClose={() => setBatchDisableOpen(false)}
            onDisable={async (ctxIds) => await store.disableContexts(ctxIds)}
        /> : null}
        {state.connection === "offline" && allCalls.length === 0
            ? <p className="empty">Tool calls are unavailable while offline.</p>
            : state.connection === "connecting" && allCalls.length === 0
              ? <p className="empty">Loading tool calls…</p>
              : selection.items.length === 0
                ? <p className="empty">{route.view === "call" ? "This Tool Call is unavailable." : active ? "No tool calls match these filters." : "No tool calls are available in this scope."}</p>
                : <ol className="feed activity-feed">
                    {selection.items.map((call) => <ToolCallEntry
                        call={call}
                        disabled={!interactive}
                        initiallyOpen={route.view === "call" && call.callId === route.callId}
                        key={`${call.instance}-${call.callId}`}
                        logs={instanceState[call.instance]?.logs ?? []}
                        onLoadDetail={async () => typeof store.readToolCallDetail === "function" ? await store.readToolCallDetail(call.instance, call.callId) : call}
                        onRefresh={async () => await store.refreshToolCall(call.instance)}
                    />)}
                </ol>}
        {route.view === "timeline" ? <Pagination
            label="Tool calls"
            onPageChange={setToolCallPage}
            page={toolCallPage}
            pageCount={pageCount(selection.total, toolCallPageSize)}
        /> : null}
    </section>;
}

function auditScope(route: Extract<WebRoute, { page: "audit" }>): AuditScope {
    if (route.view === "timeline") return route.scope;
    return route.ctxId === undefined
        ? { kind: "instance", instance: route.instance }
        : { kind: "context", instance: route.instance, ctxId: route.ctxId };
}

function auditScopeOptions(
    state: WebState,
    calls: readonly { ctxId?: string; instance: string }[],
    contextStatus: AuditContextStatusFilter,
    now: number,
    currentScope: AuditScope,
): AuditScopeOption[] {
    const instances = new Set(state.readModel.instances.map((instance) => instance.name));
    const contexts = new Map<string, {
        ctxId: string;
        instance: string;
        record?: McpContextRecord;
        status?: string;
    }>();
    for (const context of state.readModel.contexts) {
        const environments = context.environments ?? [{ instance: context.instance }];
        for (const environment of environments) {
            instances.add(environment.instance);
            contexts.set(`${environment.instance}\u0000${context.ctxId}`, {
                ctxId: context.ctxId,
                instance: environment.instance,
                record: context,
                status: context.status,
            });
        }
    }
    for (const call of calls) {
        instances.add(call.instance);
        if (call.ctxId !== undefined) {
            const key = `${call.instance}\u0000${call.ctxId}`;
            if (!contexts.has(key)) contexts.set(key, { ctxId: call.ctxId, instance: call.instance });
        }
    }
    return [
        { label: "All instances", scope: { kind: "all" } },
        ...[...instances].sort().map((instance): AuditScopeOption => ({
            label: `Instance · ${instance}`,
            scope: { kind: "instance", instance },
        })),
        ...[...contexts.values()]
            .filter((context) =>
                (currentScope.kind === "context" &&
                    currentScope.instance === context.instance &&
                    currentScope.ctxId === context.ctxId) ||
                contextMatchesFilter(context.record, contextStatus, now)
            )
            .sort((left, right) =>
                left.instance.localeCompare(right.instance) || left.ctxId.localeCompare(right.ctxId)
            )
            .map((context): AuditScopeOption => ({
                label: `Context · ${context.ctxId} · ${context.instance}${context.status === undefined ? "" : ` · ${context.status}`}`,
                scope: { kind: "context", instance: context.instance, ctxId: context.ctxId },
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
    return call.ctxId === undefined ||
        contextMatchesFilter(contextRecords.get(call.ctxId), filter, now);
}

function contextMatchesFilter(
    context: McpContextRecord | undefined,
    filter: AuditContextStatusFilter,
    now: number,
): boolean {
    if (filter === "all" || context === undefined) return true;
    if (context.status !== filter) return false;
    return filter !== "active" ||
        Date.parse(context.lastAccessedAt) >= now - activeContextWindowMs;
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
    return <nav aria-label={`${label} pagination`} className="pagination">
        <button disabled={page === 0} onClick={() => onPageChange(page - 1)} type="button">Previous page</button>
        <span aria-live="polite">Page {page + 1} of {pageCount}</span>
        <button disabled={page === pageCount - 1} onClick={() => onPageChange(page + 1)} type="button">Next page</button>
    </nav>;
}

function pageCount(total: number, size: number): number {
    return Math.max(1, Math.ceil(total / size));
}
