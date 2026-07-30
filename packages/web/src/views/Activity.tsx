import { useMemo, useState } from "react";

import { ActivityFilters } from "../components/activity/ActivityFilters.js";
import { ActivityRecord } from "../components/activity/ActivityRecord.js";
import { emptyActivityFilters, filterActivity, hasActiveActivityFilters, type ActivityFilters as Filters } from "../selectors/activity.js";
import type { WebState } from "../state/WebStore.js";

export function Activity({ state }: { state: WebState }) {
    const [filters, setFilters] = useState<Filters>(emptyActivityFilters);
    const instances = useMemo(() => [...new Set(state.activity.map((event) => event.instanceName))].sort(), [state.activity]);
    const types = useMemo(() => [...new Set(state.activity.map((event) => event.type))].sort(), [state.activity]);
    const events = useMemo(() => filterActivity(state.activity, filters), [filters, state.activity]);
    const active = hasActiveActivityFilters(filters);
    return <section>
        <h2>Activity</h2>
        <p aria-live="polite" className="hint">{events.length} of {state.activity.length} activity records{active ? " match active filters." : "."}</p>
        <ActivityFilters filters={filters} instances={instances} onChange={setFilters} onClear={() => setFilters(emptyActivityFilters)} types={types} />
        {state.connection === "offline" && state.activity.length === 0 ? <p className="empty">Activity is unavailable while offline.</p> : state.connection === "connecting" && state.activity.length === 0 ? <p className="empty">Loading activity…</p> : events.length === 0 ? <p className="empty">{active ? "No activity matches these filters." : "No recent activity."}</p> : <ol className="feed activity-feed">{events.map((event) => <ActivityRecord event={event} key={`${event.instanceName}-${event.seq}`} />)}</ol>}
    </section>;
}
