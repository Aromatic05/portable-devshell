import {
    contextFilterValue,
    type ToolCallFilters as Filters,
    type ToolCallPeriod,
    type ToolCallResult,
} from "../../selectors/toolCalls.js";

export function ToolCallFilters({
    contexts,
    filters,
    instanceLocked = false,
    instances,
    onChange,
    onClear,
    tools,
}: {
    contexts: string[];
    filters: Filters;
    instanceLocked?: boolean;
    instances: string[];
    onChange(next: Filters): void;
    onClear(): void;
    tools: string[];
}) {
    return <div className="filters activity-filters">
        <label>Search<input onChange={(event) => onChange({ ...filters, query: event.target.value })} placeholder="Tool, call, input, or error" type="search" value={filters.query} /></label>
        <label>Instance<select disabled={instanceLocked} onChange={(event) => onChange({ ...filters, instance: event.target.value })} value={filters.instance}><option value="all">All instances</option>{instances.map((instance) => <option key={instance} value={instance}>{instance}</option>)}</select></label>
        <label>Context<select onChange={(event) => onChange({ ...filters, ctxId: event.target.value })} value={filters.ctxId}><option value="all">All contexts</option><option value="unscoped">Unscoped</option>{contexts.map((ctxId) => <option key={ctxId} value={contextFilterValue(ctxId)}>{ctxId}</option>)}</select></label>
        <label>Tool<select onChange={(event) => onChange({ ...filters, tool: event.target.value })} value={filters.tool}><option value="all">All tools</option>{tools.map((tool) => <option key={tool} value={tool}>{tool}</option>)}</select></label>
        <label>Result<select onChange={(event) => onChange({ ...filters, result: event.target.value as ToolCallResult })} value={filters.result}><option value="all">All results</option><option value="success">Success</option><option value="pending">Pending</option><option value="failure">Failure</option></select></label>
        <label>Time range<select onChange={(event) => onChange({ ...filters, period: event.target.value as ToolCallPeriod })} value={filters.period}><option value="all">All time</option><option value="1h">Last hour</option><option value="24h">Last 24 hours</option></select></label>
        <button className="secondary" onClick={onClear} type="button">Clear filters</button>
    </div>;
}
