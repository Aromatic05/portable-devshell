import type { ActivityFilters as Filters, ActivityPeriod, ActivityResult } from "../../selectors/activity.js";

export function ActivityFilters({
    filters,
    instances,
    onChange,
    onClear,
    types,
}: {
    filters: Filters;
    instances: string[];
    onChange(next: Filters): void;
    onClear(): void;
    types: string[];
}) {
    return <div className="filters activity-filters">
        <label>Search<input onChange={(event) => onChange({ ...filters, query: event.target.value })} placeholder="Instance or event" type="search" value={filters.query} /></label>
        <label>Instance<select onChange={(event) => onChange({ ...filters, instance: event.target.value })} value={filters.instance}><option value="all">All instances</option>{instances.map((instance) => <option key={instance} value={instance}>{instance}</option>)}</select></label>
        <label>Event type<select onChange={(event) => onChange({ ...filters, type: event.target.value })} value={filters.type}><option value="all">All event types</option>{types.map((type) => <option key={type} value={type}>{type}</option>)}</select></label>
        <label>Result<select onChange={(event) => onChange({ ...filters, result: event.target.value as ActivityResult })} value={filters.result}><option value="all">All results</option><option value="success">Success</option><option value="pending">Pending</option><option value="failure">Failure</option><option value="other">Other</option></select></label>
        <label>Time range<select onChange={(event) => onChange({ ...filters, period: event.target.value as ActivityPeriod })} value={filters.period}><option value="all">All time</option><option value="1h">Last hour</option><option value="24h">Last 24 hours</option></select></label>
        <button className="secondary" onClick={onClear} type="button">Clear filters</button>
    </div>;
}
