import { readFileSync } from "node:fs";
import { statfs } from "node:fs/promises";
import {
    cpus,
    freemem,
    homedir,
    loadavg,
    totalmem
} from "node:os";

import {
    createOperationalOverviewSystemCollection,
    type OperationalOverviewCpuTimes,
    type OperationalOverviewDiskUsage,
    type OperationalOverviewSystemCollection
} from "./OperationalOverviewSystemPolicy.js";

export type {
    OperationalOverviewCpuTimes,
    OperationalOverviewDiskUsage,
    OperationalOverviewSystemCollection
} from "./OperationalOverviewSystemPolicy.js";

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
        const cpu = this.#cpuTimes();
        let disk: OperationalOverviewDiskUsage | undefined;
        try {
            disk = await this.#diskUsage(this.#diskPath);
        } catch {
            // Disk metrics are optional on platforms without statfs support.
        }
        const result = createOperationalOverviewSystemCollection({
            cpu,
            cpuCount: this.#cpuCount(),
            ...(disk === undefined ? {} : { disk }),
            diskPath: this.#diskPath,
            freeMemoryBytes: this.#freeMemoryBytes(),
            load1m: this.#load1m(),
            ...(this.#previousCpu === undefined ? {} : { previousCpu: this.#previousCpu }),
            totalMemoryBytes: this.#totalMemoryBytes()
        });
        this.#previousCpu = cpu;
        return result;
    }
}

function readCpuTimes(): OperationalOverviewCpuTimes {
    return cpus().reduce<OperationalOverviewCpuTimes>((aggregate, cpu) => ({
        idle: aggregate.idle + cpu.times.idle,
        total: aggregate.total + Object.values(cpu.times)
            .reduce((total, value) => total + value, 0)
    }), { idle: 0, total: 0 });
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
            if (value !== undefined) return Number(value) * 1024;
        } catch {
            // Fall through to the portable OS value.
        }
    }
    return freemem();
}
