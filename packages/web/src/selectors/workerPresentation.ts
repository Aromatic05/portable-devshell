import type { OperationalOverviewWorker } from "../../../shared/src/dto/overview/DtoOperationalOverview.js";

export interface WorkerPresentation {
    capabilities: Array<{ label: string; value: string }>;
    distribution: string;
    packageManager: string;
    platform: string;
    protocol: string;
    shell: string;
    version: string;
}

export function presentWorker(worker: OperationalOverviewWorker | undefined): WorkerPresentation | undefined {
    if (worker === undefined) return undefined;
    const distribution = worker.platform.distribution;
    const shell = worker.platform.shell;
    return {
        capabilities: [
            { label: "Tools", value: worker.capabilities.tools ? "available" : "unavailable" },
            { label: "Streaming", value: worker.capabilities.streaming ? "available" : "unavailable" },
            { label: "Cancel", value: worker.capabilities.cancel ? "available" : "unavailable" },
        ],
        distribution: distribution === undefined ? "Unavailable" : `${distribution.name} ${distribution.version ?? ""}`.trim(),
        packageManager: worker.platform.packageManager ?? "Unavailable",
        platform: `${worker.platform.os} / ${worker.platform.arch}`,
        protocol: String(worker.protocolVersion),
        shell: shell === undefined ? "Unavailable" : `${shell.kind} ${shell.version} (${shell.executable})`,
        version: worker.version,
    };
}
