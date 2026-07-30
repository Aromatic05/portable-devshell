import assert from "node:assert/strict";
import test from "node:test";

import { OperationalOverviewSystemCollector } from "../../src/control/overview/OperationalOverviewSystemCollector.ts";

test("controller system collector samples CPU deltas and reports resource pressure", async () => {
    const cpuSamples = [
        { idle: 200, total: 1_000 },
        { idle: 250, total: 1_200 }
    ];
    let cpuIndex = 0;
    const collector = new OperationalOverviewSystemCollector({
        cpuCount: () => 4,
        cpuTimes: () => cpuSamples[Math.min(cpuIndex++, cpuSamples.length - 1)]!,
        diskPath: "/state",
        diskUsage: async () => ({ availableBytes: 40, totalBytes: 1_000 }),
        freeMemoryBytes: () => 80,
        load1m: () => 3.5,
        totalMemoryBytes: () => 1_000
    });

    const first = await collector.collect();
    const second = await collector.collect();

    assert.deepEqual(first.system, {
        cpuCount: 4,
        cpuPercent: 80,
        diskAvailableBytes: 40,
        diskPath: "/state",
        diskPercent: 96,
        diskTotalBytes: 1_000,
        load1m: 3.5,
        memoryAvailableBytes: 80,
        memoryPercent: 92,
        memoryTotalBytes: 1_000
    });
    assert.equal(second.system.cpuPercent, 75);
    assert.deepEqual(
        first.alerts.map((alert) => [alert.kind, alert.severity]),
        [
            ["controller.diskPressure", "critical"],
            ["controller.memoryPressure", "attention"]
        ]
    );
});

test("controller system collector degrades when disk usage is unavailable", async () => {
    const collector = new OperationalOverviewSystemCollector({
        cpuCount: () => 2,
        cpuTimes: () => ({ idle: 50, total: 100 }),
        diskPath: "/missing",
        diskUsage: async () => {
            throw new Error("unsupported");
        },
        freeMemoryBytes: () => 500,
        load1m: () => 0,
        totalMemoryBytes: () => 1_000
    });

    const result = await collector.collect();

    assert.equal(result.system.diskPercent, undefined);
    assert.equal(result.system.diskPath, "/missing");
    assert.deepEqual(result.alerts, []);
});
