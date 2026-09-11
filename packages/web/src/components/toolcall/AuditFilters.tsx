import { useState } from "react";

import { webRouteHref, type AuditScope } from "../../routing/hashRoute.js";
import {
    type ToolCallFilters as Filters,
    type ToolCallPeriod,
    type ToolCallResult,
} from "../../selectors/toolCalls.js";

export type AuditContextStatusFilter = "active" | "expired" | "disabled" | "all";

export interface AuditScopeOption {
    group?: { id: string; label: string };
    label: string;
    scope: AuditScope;
}

export function AuditFilters({
    contextStatus,
    filters,
    onChange,
    onClear,
    onContextStatusChange,
    onScopeChange,
    scope,
    scopes,
    tools,
}: {
    contextStatus: AuditContextStatusFilter;
    filters: Filters;
    onChange(next: Filters): void;
    onClear(): void;
    onContextStatusChange(status: AuditContextStatusFilter): void;
    onScopeChange(scope: AuditScope): void;
    scope: AuditScope;
    scopes: readonly AuditScopeOption[];
    tools: readonly string[];
}) {
    const [advancedOpen, setAdvancedOpen] = useState(false);
    const [scopeQuery, setScopeQuery] = useState("");
    const advancedCount = [
        contextStatus !== "all",
        filters.workspace.length > 0,
        filters.tool !== "all",
        filters.period !== "all",
    ].filter(Boolean).length;
    const scopeValue = webRouteHref({ page: "audit", view: "timeline", scope });
    const visibleScopes = filterScopeOptions(scopes, scopeQuery, scopeValue);
    const scopeGroups = groupScopeOptions(visibleScopes);

    return <div className="audit-query">
        <div className="audit-query-primary">
            <div className="audit-scope">
                <label htmlFor="audit-scope-select">Scope</label>
                <input
                    aria-label="Search scopes"
                    onChange={(event) => setScopeQuery(event.target.value)}
                    placeholder="Workspace, Context, or Instance"
                    type="search"
                    value={scopeQuery}
                />
                <select
                    id="audit-scope-select"
                    onChange={(event) => {
                        const option = scopes.find((candidate) =>
                            webRouteHref({ page: "audit", view: "timeline", scope: candidate.scope }) === event.target.value
                        );
                        if (option !== undefined) onScopeChange(option.scope);
                    }}
                    value={scopeValue}
                >
                    {scopeGroups.ungrouped.map((option) => {
                        const value = webRouteHref({ page: "audit", view: "timeline", scope: option.scope });
                        return <option key={value} value={value}>{option.label}</option>;
                    })}
                    {scopeGroups.grouped.map((group) => <optgroup key={group.id} label={group.label}>
                        {group.options.map((option) => {
                            const value = webRouteHref({ page: "audit", view: "timeline", scope: option.scope });
                            return <option key={value} value={value}>{option.label}</option>;
                        })}
                    </optgroup>)}
                </select>
            </div>
            <label className="audit-search">Search audit
                <input
                    onChange={(event) => onChange({ ...filters, query: event.target.value })}
                    placeholder="Tool, call, input, output, or error"
                    type="search"
                    value={filters.query}
                />
            </label>
            <button
                aria-expanded={advancedOpen}
                className="secondary audit-filter-toggle"
                onClick={() => setAdvancedOpen((open) => !open)}
                type="button"
            >Filters{advancedCount > 0 ? ` (${advancedCount})` : ""}</button>
        </div>
        <div aria-label="Result" className="audit-quick-filters" role="group">
            {([
                ["all", "All"],
                ["failure", "Failures"],
                ["pending", "Pending"],
                ["success", "Success"],
            ] as const).map(([value, label]) => <button
                aria-pressed={filters.result === value}
                className={filters.result === value ? "selected" : ""}
                key={value}
                onClick={() => onChange({ ...filters, result: value as ToolCallResult })}
                type="button"
            >{label}</button>)}
        </div>
        {advancedCount === 0 ? null : <div aria-label="Active filters" className="audit-filter-chips" role="group">
            {contextStatus === "all" ? null : <button onClick={() => onContextStatusChange("all")} type="button">
                {contextStatus === "active" ? "Context: Active · last 30 min ×" : `Context: ${contextStatus} ×`}
            </button>}
            {filters.workspace.length === 0 ? null : <button onClick={() => onChange({ ...filters, workspace: "" })} type="button">Workspace: {filters.workspace} ×</button>}
            {filters.tool === "all" ? null : <button onClick={() => onChange({ ...filters, tool: "all" })} type="button">Tool: {filters.tool} ×</button>}
            {filters.period === "all" ? null : <button onClick={() => onChange({ ...filters, period: "all" })} type="button">Time: {filters.period} ×</button>}
        </div>}
        {advancedOpen ? <div className="audit-advanced-filters">
            <label>Context status<select onChange={(event) => onContextStatusChange(event.target.value as AuditContextStatusFilter)} value={contextStatus}><option value="active">Active · last 30 min</option><option value="expired">Expired</option><option value="disabled">Disabled</option><option value="all">All statuses</option></select></label>
            <label>Workspace<input onChange={(event) => onChange({ ...filters, workspace: event.target.value })} placeholder="Path or folder" type="search" value={filters.workspace} /></label>
            <label>Tool<select onChange={(event) => onChange({ ...filters, tool: event.target.value })} value={filters.tool}><option value="all">All tools</option>{tools.map((tool) => <option key={tool} value={tool}>{tool}</option>)}</select></label>
            <label>Time range<select onChange={(event) => onChange({ ...filters, period: event.target.value as ToolCallPeriod })} value={filters.period}><option value="all">All time</option><option value="1h">Last hour</option><option value="24h">Last 24 hours</option></select></label>
            <button className="secondary" onClick={onClear} type="button">Clear filters</button>
        </div> : null}
    </div>;
}

function filterScopeOptions(
    scopes: readonly AuditScopeOption[],
    query: string,
    currentValue: string,
): AuditScopeOption[] {
    const needle = query.trim().toLocaleLowerCase();
    if (needle.length === 0) return [...scopes];
    return scopes.filter((option) => {
        const value = webRouteHref({ page: "audit", view: "timeline", scope: option.scope });
        if (value === currentValue) return true;
        return `${option.group?.label ?? ""} ${option.label}`.toLocaleLowerCase().includes(needle);
    });
}

function groupScopeOptions(scopes: readonly AuditScopeOption[]): {
    grouped: Array<{ id: string; label: string; options: AuditScopeOption[] }>;
    ungrouped: AuditScopeOption[];
} {
    const grouped = new Map<string, { id: string; label: string; options: AuditScopeOption[] }>();
    const ungrouped: AuditScopeOption[] = [];
    for (const option of scopes) {
        if (option.group === undefined) {
            ungrouped.push(option);
            continue;
        }
        const group = grouped.get(option.group.id) ?? { ...option.group, options: [] };
        group.options.push(option);
        grouped.set(option.group.id, group);
    }
    return { grouped: [...grouped.values()], ungrouped };
}
