import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const root = dirname(dirname(scriptPath));
const cgroupMarker = "PORTABLE_DEVSHELL_TRANSPORT_STRESS_CGROUP";

if (process.env[cgroupMarker] !== "1") {
    const result = spawnSync(
        "systemd-run",
        [
            "--user",
            "--wait",
            "--collect",
            "--pipe",
            "--property=MemoryHigh=1073741824",
            "--property=MemoryMax=1610612736",
            "--property=MemorySwapMax=0",
            "--property=CPUQuota=150%",
            "--property=TasksMax=256",
            "--property=IOWeight=50",
            "--property=RuntimeMaxSec=300",
            "--property=Nice=10",
            `--setenv=${cgroupMarker}=1`,
            "--setenv=PORTABLE_DEVSHELL_TEST_WATCHDOG_MS=280000",
            `--setenv=PATH=${process.env.PATH ?? "/usr/bin:/bin"}`,
            `--working-directory=${root}`,
            process.execPath,
            scriptPath,
            ...process.argv.slice(2),
        ],
        { cwd: root, stdio: "inherit" },
    );
    if (result.error !== undefined) throw result.error;
    process.exit(result.status ?? 1);
}

const cgroup = readFileSync("/proc/self/cgroup", "utf8")
    .split("\n")
    .find((line) => line.startsWith("0::"))
    ?.slice(3);
if (cgroup === undefined || cgroup.length === 0) {
    throw new Error("transport stress runner requires a cgroup v2 unit");
}
const cgroupRoot = join("/sys/fs/cgroup", cgroup);
const memoryMax = readFileSync(join(cgroupRoot, "memory.max"), "utf8").trim();
const cpuMax = readFileSync(join(cgroupRoot, "cpu.max"), "utf8").trim();
const tasksMax = readFileSync(join(cgroupRoot, "pids.max"), "utf8").trim();
if (memoryMax === "max" || tasksMax === "max" || cpuMax.startsWith("max ")) {
    throw new Error("transport stress runner refuses to run without resource limits");
}
console.log(
    `transport stress cgroup: memory.max=${memoryMax} cpu.max=${cpuMax} pids.max=${tasksMax}`,
);

run("cargo", ["build", "--locked", "-p", "devshell-worker"]);

const testRunner = join(root, "test", "RunPackageTests.mjs");
run(
    process.execPath,
    [
        testRunner,
        "--loader",
        "packages/core/test/RegisterWorkspacePackages.mjs",
        "--concurrency",
        "1",
        "test/stress/*.stress.test.ts",
    ],
);

const controlLoader = "packages/mcp/test/RegisterWorkspacePackages.mjs";
for (let round = 1; round <= 8; round += 1) {
    console.log(`reverse gateway stress round ${round}/8`);
    run(process.execPath, [
        testRunner,
        "--loader",
        controlLoader,
        "--concurrency",
        "1",
        "packages/control/test/integration/ReverseConnectionGateway.test.ts",
    ]);
}

console.log("real reverse carrier stress: proxied WSS + direct re-enroll");
run(process.execPath, [
    testRunner,
    "--loader",
    controlLoader,
    "--concurrency",
    "1",
    "packages/control/test/integration/worker/Reverse.test.ts",
]);

function run(command, args) {
    const result = spawnSync(command, args, {
        cwd: root,
        env: process.env,
        stdio: "inherit",
    });
    if (result.error !== undefined) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
}
