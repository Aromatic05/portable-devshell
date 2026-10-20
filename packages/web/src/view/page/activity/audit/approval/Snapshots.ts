import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ApprovalRequest, InstanceListEntry } from "@portable-devshell/shared";
import type { WebDomainSession } from "../../../../../app/domain/Session.js";
import type { ToolCallFilters } from "../tool/Model.js";

export function useApprovalSnapshots(
    domains: WebDomainSession,
    instances: readonly InstanceListEntry[],
    online: boolean,
) {
    const candidates = instances.map(({ name }) => ({
        instance: name,
        source: domains.approval(name),
    })).sort((left, right) => left.instance.localeCompare(right.instance));
    const sourceCache = useRef(candidates);
    if (candidates.length !== sourceCache.current.length || candidates.some((candidate, index) =>
        candidate.instance !== sourceCache.current[index]?.instance || candidate.source !== sourceCache.current[index]?.source)) {
        sourceCache.current = candidates;
    }
    const sources = sourceCache.current;
    const observable = useMemo(() => {
        let current = sources.map(({ instance, source }) => ({ instance, state: source.state }));
        return {
            subscribe(listener: () => void) {
                const subscriptions = sources.map(({ source }) => source.subscribe(listener));
                return () => { for (const unsubscribe of subscriptions) unsubscribe(); };
            },
            snapshot() {
                if (sources.some(({ source }, index) => source.state !== current[index]?.state)) {
                    current = sources.map(({ instance, source }) => ({ instance, state: source.state }));
                }
                return current;
            },
        };
    }, [sources]);
    const snapshots = useSyncExternalStore(observable.subscribe, observable.snapshot, observable.snapshot);
    const [attempt, setAttempt] = useState(0);
    const [reads, setReads] = useState<{
        sources: typeof sources;
        pending: string[];
        failures: Record<string, string>;
    }>();
    useEffect(() => {
        if (!online) return;
        let active = true;
        setReads({ sources, pending: sources.map(({ instance }) => instance), failures: {} });
        for (const { instance, source } of sources) {
            void source.load().then(() => {
                if (!active) return;
                setReads((previous) => previous?.sources !== sources ? previous : {
                    ...previous, pending: previous.pending.filter((name) => name !== instance),
                });
            }, (error: unknown) => {
                if (!active) return;
                setReads((previous) => previous?.sources !== sources ? previous : {
                    ...previous,
                    pending: previous.pending.filter((name) => name !== instance),
                    failures: { ...previous.failures, [instance]: error instanceof Error ? error.message : String(error) },
                });
            });
        }
        return () => { active = false; };
    }, [attempt, online, sources]);
    const approvals = snapshots.flatMap(({ instance, state }) => state.approvals.filter(
        (approval) => approval.instance === instance && approval.status === "pending",
    ));
    return {
        approvals,
        pending: reads?.sources === sources && online ? reads.pending : [],
        failures: reads?.sources === sources ? reads.failures : {},
        retry: () => setAttempt((previous) => previous + 1),
    };
}

export function approvalMatchesFilters(approval: ApprovalRequest, filters: ToolCallFilters, now: number): boolean {
    if (filters.result !== "all" && filters.result !== "pending") return false;
    const ctxId = filters.ctxId.trim().toLowerCase();
    if (ctxId.length > 0 && (approval.ctxId ?? "").toLowerCase() !== ctxId) return false;
    if (filters.tool !== "all" && approval.toolName !== filters.tool) return false;
    const workspace = filters.workspace.trim().toLowerCase();
    if (workspace.length > 0 && !(approval.workspace ?? "").toLowerCase().includes(workspace)) return false;
    const minTime = filters.period === "1h" ? now - 3_600_000 : filters.period === "24h" ? now - 86_400_000 : undefined;
    if (minTime !== undefined && Date.parse(approval.createdAt) < minTime) return false;
    const query = filters.query.trim().toLowerCase();
    return query.length === 0 || [
        approval.approvalId, approval.callId, approval.ctxId, approval.instance,
        approval.toolName, approval.workspace, approval.reason, approval.inputSummary,
        approval.source, approval.riskLevel,
    ].join(" ").toLowerCase().includes(query);
}
