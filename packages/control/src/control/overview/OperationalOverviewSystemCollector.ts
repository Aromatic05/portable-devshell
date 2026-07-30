import { readFileSync } from "node:fs";
import { statfs } from "node:fs/promises";
import {
    cpus,
    freemem,
    homedir,
    loadavg,
    totalmem
} from "node:os";

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

export interface OperationalOverviewSystemCollectorOptions {
    cpuCount?: () => number;
    cpuTimes?: () => OperationalOverviewCpuTimes;
    diskPath?: string;
    diskUsage?: (path: string) => Promise<OperationalOverviewDiskUsage>;
    freeMemoryBytes?: () => number;
    load1m?: () => number;
    totalMemoryBytes?: () => number;
}

export class OperationalOverviewSystemCollector {
    readonly #cpuCount: () => number;
    readonly #cpuTimes: () => OperationalOverviewCpuTimes;
    readonly #diskPath: string;
    readonly #diskUsage: (path: string) => Promise<OperationalOverviewDiskUsage>;
    readonly #freeMemoryBytes: () => number;
    readonly #load1m: () => number;
    readonly #totalMemoryBytes: () => number;
    #previousCpu?: OperationalOverviewCpuTimes;

    constructor(options: OperationalOverviewSystemCollectorOptions = {}) {
        this.#cpuCount = options.cpuCount ?? (() => Math.max(1, cpus().length));
        this.#cpuTimes = options.cpuTimes ?? readCpuTimes;
        this.#diskPath = options.diskPath ?? homedir();
        this.#diskUsage = options.diskUsage ?? readDiskUsage;
        this.#freeMemoryBytes = options.freeMemoryBytes ?? readAvailableMemoryBytes;
        this.#load1m = options.load1m ?? (() => loadavg()[0] ?? 0);
        this.#totalMemoryBytes = options.totalMemoryBytes ?? totalmem;
    }

    async collect(): Promise<OperationalOverviewSystemCollection> {
        const cpu = normalizeCpuTimes(this.#cpuTimes());
        const cpuPercent = calculateCpuPercent(this.#previousCpu, cpu);
        this.#previousCpu = cpu;

        const memoryTotalBytes = normalizeBytes(this.#totalMemoryBytes());
        const memoryAvailableBytes = Math.min(
            memoryTotalBytes,
            normalizeBytes(this.#freeMemoryBytes())
        );
        const memoryPercent = usedPercent(
            memoryTotalBytes - memoryAvailableBytes,
            memoryTotalBytes
        );
        const system: OperationalOverviewSystem = {
            cpuCount: Math.max(1, Math.floor(this.#cpuCount())),
            ...(cpuPercent === undefined ? {} : { cpuPercent }),
            diskPath: this.#diskPath,
            load1m: normalizeLoad(this.#load1m()),
            memoryAvailableBytes,
            memoryPercent,
            memoryTotalBytes
        };
        const alerts: OperationalOverviewAlert[] = [];

        try {
            const disk = await this.#diskUsage(this.#diskPath);
            const diskTotalBytes = normalizeBytes(disk.totalBytes);
            const diskAvailableBytes = Math.min(
                diskTotalBytes,
                normalizeBytes(disk.availableBytes)
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
                detail: `${this.#diskPath} has ${diskAvailableBytes} bytes available.`,
                id: "controller.diskPressure",
                kind: "controller.diskPressure",
                percent: diskPercent,
                title: "Controller disk pressure"
            });
            if (diskAlert !== undefined) {
                alerts.push(diskAlert);
            }
        } catch {
            // Disk metrics are optional on platforms without statfs support.
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
        if (memoryAlert !== undefined) {
            alerts.push(memoryAlert);
        }

        return { alerts, system };
    }
}

function readCpuTimes(): OperationalOverviewCpuTimes {
    return cpus().reduce<OperationalOverviewCpuTimes>((aggregate, cpu) => {
        const times = Object.values(cpu.times);
        return {
            idle: aggregate.idle + cpu.times.idle,
            total: aggregate.total + times.reduce((total, value) => total + value, 0)
        };
    }, { idle: 0, total: 0 });
}

async function readDiskUsage(path: string): Promise<OperationalOverviewDiskUsage> {
    const stats = await statfs(path);
    const blockSize = Number(stats.bsize);
    return {
        availableBytes: blockSize * Number(stats.bavail),
        totalBytes: blockSize * Number(stats.blocks)
    };
}

function readAvailableMemoryBytes(): number {
    if (process.platform === "linux") {
        try {
            const value = readFileSync("/proc/meminfo", "utf8")
                .match(/^MemAvailable:\s+(\d+)\s+kB$/mu)?.[1];
            if (value !== undefined) {
                return Number(value) * 1024;
            }
        } catch {
            // Fall through to the portable OS value.
        }
    }
    return freemem();
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
    if (total <= 0 || idle < 0 || idle > total) {
        return undefined;
    }
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
    if (input.percent < input.attentionPercent) {
        return undefined;
    }
    const severity = input.percent >= input.criticalPercent
        ? "critical"
        : "attention";
    return {
        detail: `${input.percent}% used; ${input.detail}`,
        id: input.id,
        kind: input.kind,
        severity,
        title: input.title
    };
}
