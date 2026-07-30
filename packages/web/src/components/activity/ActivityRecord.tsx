import type { InstanceEvent } from "@portable-devshell/shared/browser";

import { formatEventPayload, formatRelativeTime } from "../../formatters/activity.js";
import { activityResult } from "../../selectors/activity.js";

export function ActivityRecord({ event }: { event: InstanceEvent }) {
    return <li className="activity-record">
        <details>
            <summary><time dateTime={event.at} title={event.at}>{formatRelativeTime(event.at)}</time><strong>{event.instanceName}</strong><span>{event.type}</span><span className={`result ${activityResult(event)}`}>{activityResult(event)}</span></summary>
            <dl className="activity-detail"><div><dt>Time</dt><dd>{event.at}</dd></div><div><dt>Instance</dt><dd>{event.instanceName}</dd></div><div><dt>Event type</dt><dd>{event.type}</dd></div><div><dt>Sequence</dt><dd>{event.seq}</dd></div></dl>
            <h3>Safe payload</h3><pre>{formatEventPayload(event.data)}</pre>
        </details>
    </li>;
}
