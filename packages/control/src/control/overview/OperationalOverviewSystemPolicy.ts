import type {
    OperationalOverviewAlert,
    OperationalOverviewSystem
} from "@portable-devshell/shared";

const diskAttentionPercent = 85;
const diskCriticalPercent = 95;
const memoryAttentionPercent = 90;
const memoryCriticalPercent = 97;

export interface OperationalOverviewCpuTimes {
    idle: number;
    total: number;
}

export interface OperationalOverviewDiskUsage {
    availableBytes: number;
    totalBytes: number;
}

export interface OperationalOverviewSystemCollection {
    alerts: OperationalOverviewAlert[];
    system: OperationalOverviewSystem;
}

export interface OperationalOverviewSystemSample {
    cpu: OperationalOverviewCpuTimes;
    cpuCount: number;
    disk?: OperationalOverviewDiskUsage;
    diskPath: string;
    freeMemoryBytes: number;
    load1m: number;
    previousCpu?: OperationalOverviewCpuTimes;
    totalMemoryBytes: number;
}

export function createOperationalOverviewSystemCollection(
    sample: OperationalOverviewSystemSample
): OperationalOverviewSystemCollection {
    const cpu = normalizeCpuTimes(sample.cpu);
    const previousCpu = sample.previousCpu === undefined
        ? undefined
        : normalizeCpuTimes(sample.previousCpu);
    const cpuPercent = calculateCpuPercent(previousCpu, cpu);
    const memoryTotalBytes = normalizeBytes(sample.totalMemoryBytes);
    const memoryAvailableBytes = Math.min(
        memoryTotalBytes,
        normalizeBytes(sample.freeMemoryBytes)
    );
    const memoryPercent = usedPercent(
        memoryTotalBytes - memoryAvailableBytes,
        memoryTotalBytes
    );
    const system: OperationalOverviewSystem = {
        cpuCount: Math.max(1, Math.floor(sample.cpuCount)),
        ...(cpuPercent === undefined ? {} : { cpuPercent }),
        diskPath: sample.diskPath,
        load1m: normalizeLoad(sample.load1m),
        memoryAvailableBytes,
        memoryPercent,
        memoryTotalBytes
    };
    const alerts: OperationalOverviewAlert[] = [];

    if (sample.disk !== undefined) {
        const diskTotalBytes = normalizeBytes(sample.disk.totalBytes);
        const diskAvailableBytes = Math.min(
            diskTotalBytes,
            normalizeBytes(sample.disk.availableBytes)
        );
        const diskPercent = usedPercent(
            diskTotalBytes - diskAvailableBytes,
            diskTotalBytes
        );
        Object.assign(system, {
            diskAvailableBytes,
            diskPercent,
            diskTotalBytes
        });
        const diskAlert = resourceAlert({
            attentionPercent: diskAttentionPercent,
            criticalPercent: diskCriticalPercent,
            detail: `${sample.diskPath} has ${diskAvailableBytes} bytes available.`,
            id: "controller.diskPressure",
            kind: "controller.diskPressure",
            percent: diskPercent,
            title: "Controller disk pressure"
        });
        if (diskAlert !== undefined) alerts.push(diskAlert);
    }

    const memoryAlert = resourceAlert({
        attentionPercent: memoryAttentionPercent,
        criticalPercent: memoryCriticalPercent,
        detail: `${memoryAvailableBytes} of ${memoryTotalBytes} bytes available.`,
        id: "controller.memoryPressure",
        kind: "controller.memoryPressure",
        percent: memoryPercent,
        title: "Controller memory pressure"
    });
    if (memoryAlert !== undefined) alerts.push(memoryAlert);

    return { alerts, system };
}

function calculateCpuPercent(
    previous: OperationalOverviewCpuTimes | undefined,
    current: OperationalOverviewCpuTimes
): number | undefined {
    const total = previous === undefined
        ? current.total
        : current.total - previous.total;
    const idle = previous === undefined
        ? current.idle
        : current.idle - previous.idle;
    if (total <= 0 || idle < 0 || idle > total) return undefined;
    return roundPercent((total - idle) * 100 / total);
}

function normalizeCpuTimes(value: OperationalOverviewCpuTimes): OperationalOverviewCpuTimes {
    return {
        idle: normalizeBytes(value.idle),
        total: normalizeBytes(value.total)
    };
}

function normalizeBytes(value: number): number {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function normalizeLoad(value: number): number | undefined {
    return Number.isFinite(value) && value >= 0
        ? Math.round(value * 100) / 100
        : undefined;
}

function usedPercent(used: number, total: number): number {
    return total <= 0 ? 0 : roundPercent(used * 100 / total);
}

function roundPercent(value: number): number {
    return Math.round(Math.max(0, Math.min(100, value)) * 10) / 10;
}

function resourceAlert(input: {
    attentionPercent: number;
    criticalPercent: number;
    detail: string;
    id: string;
    kind: "controller.diskPressure" | "controller.memoryPressure";
    percent: number;
    title: string;
}): OperationalOverviewAlert | undefined {
    if (input.percent < input.attentionPercent) return undefined;
    return {
        detail: `${input.percent}% used; ${input.detail}`,
        id: input.id,
        kind: input.kind,
        severity: input.percent >= input.criticalPercent ? "critical" : "attention",
        title: input.title
    };
}
