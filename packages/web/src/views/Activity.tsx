import { useState } from "react";

import { recentActivity } from "../selectors/readModel.js";
import type { WebState } from "../state/WebStore.js";
import { ActivityList } from "./Overview.js";

export function Activity({ state }: { state: WebState }) {
    const [query, setQuery] = useState("");
    const [type, setType] = useState("all");
    const types = [...new Set(state.activity.map((event) => event.type))].sort();
    return (
        <section>
            <h2>Activity</h2>
            <div className="filters">
                <label>Search<input onChange={(event) => setQuery(event.target.value)} placeholder="Instance or event" type="search" value={query} /></label>
                <label>Type<select onChange={(event) => setType(event.target.value)} value={type}><option value="all">All activity</option>{types.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
            </div>
            <ActivityList empty="No activity matches these filters." events={recentActivity(state, query, type)} />
        </section>
    );
}
