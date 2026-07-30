import type { OperationalOverviewSystem } from "@portable-devshell/shared/browser";

import { formatBytes, formatDuration, formatPercent } from "../../formatters/resources.js";

export function SystemResources({
    system,
    uptimeSeconds,
}: {
    system: OperationalOverviewSystem | undefined;
    uptimeSeconds: number | undefined;
}) {
    return <section aria-label="Controller resources" className="resource-metrics">
        <ResourceMetric label="CPU" value={formatPercent(system?.cpuPercent)} detail={system === undefined ? "Unavailable" : `${system.cpuCount} cores`} />
        <ResourceMetric label="Memory" value={formatPercent(system?.memoryPercent)} detail={system === undefined ? "Unavailable" : `${formatBytes(system.memoryAvailableBytes)} available of ${formatBytes(system.memoryTotalBytes)}`} />
        <ResourceMetric label="Disk" value={formatPercent(system?.diskPercent)} detail={system?.diskTotalBytes === undefined ? "Unavailable" : `${formatBytes(system.diskAvailableBytes)} available of ${formatBytes(system.diskTotalBytes)}`} />
        <ResourceMetric label="Load / uptime" value={system?.load1m === undefined ? "Unavailable" : system.load1m.toFixed(2)} detail={formatDuration(uptimeSeconds)} />
    </section>;
}

function ResourceMetric({ detail, label, value }: { detail: string; label: string; value: string }) {
    return <div className="card resource-card"><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>;
}
