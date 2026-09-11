import { useState } from "react";

import { webRouteHref, type AuditScope } from "../../routing/hashRoute.js";
import {
    type ToolCallFilters as Filters,
    type ToolCallPeriod,
    type ToolCallResult,
} from "../../selectors/toolCalls.js";

export interface AuditScopeOption {
    label: string;
    scope: AuditScope;
}

export function AuditFilters({
    filters,
    onChange,
    onClear,
    onScopeChange,
    scope,
    scopes,
    tools,
}: {
    filters: Filters;
    onChange(next: Filters): void;
    onClear(): void;
    onScopeChange(scope: AuditScope): void;
    scope: AuditScope;
    scopes: readonly AuditScopeOption[];
    tools: readonly string[];
}) {
    const [advancedOpen, setAdvancedOpen] = useState(false);
    const advancedCount = [
        filters.workspace.length > 0,
        filters.tool !== "all",
        filters.period !== "all",
    ].filter(Boolean).length;
    const scopeValue = webRouteHref({ page: "audit", view: "timeline", scope });

    return <div className="audit-query">
        <div className="audit-query-primary">
            <label className="audit-scope">Scope
                <select
                    onChange={(event) => {
                        const option = scopes.find((candidate) =>
                            webRouteHref({ page: "audit", view: "timeline", scope: candidate.scope }) === event.target.value
                        );
                        if (option !== undefined) onScopeChange(option.scope);
                    }}
                    value={scopeValue}
                >
                    {scopes.map((option) => {
                        const value = webRouteHref({ page: "audit", view: "timeline", scope: option.scope });
                        return <option key={value} value={value}>{option.label}</option>;
                    })}
                </select>
            </label>
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
            {filters.workspace.length === 0 ? null : <button onClick={() => onChange({ ...filters, workspace: "" })} type="button">Workspace: {filters.workspace} ×</button>}
            {filters.tool === "all" ? null : <button onClick={() => onChange({ ...filters, tool: "all" })} type="button">Tool: {filters.tool} ×</button>}
            {filters.period === "all" ? null : <button onClick={() => onChange({ ...filters, period: "all" })} type="button">Time: {filters.period} ×</button>}
        </div>}
        {advancedOpen ? <div className="audit-advanced-filters">
            <label>Workspace<input onChange={(event) => onChange({ ...filters, workspace: event.target.value })} placeholder="Path or folder" type="search" value={filters.workspace} /></label>
            <label>Tool<select onChange={(event) => onChange({ ...filters, tool: event.target.value })} value={filters.tool}><option value="all">All tools</option>{tools.map((tool) => <option key={tool} value={tool}>{tool}</option>)}</select></label>
            <label>Time range<select onChange={(event) => onChange({ ...filters, period: event.target.value as ToolCallPeriod })} value={filters.period}><option value="all">All time</option><option value="1h">Last hour</option><option value="24h">Last 24 hours</option></select></label>
            <button className="secondary" onClick={onClear} type="button">Clear filters</button>
        </div> : null}
    </div>;
}
