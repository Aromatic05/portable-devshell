import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createTestTempDirectory } from "../test/TestTempDirectory.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const smokeScript = fileURLToPath(new URL("./smoke-package.mjs", import.meta.url));

const fixtureCli = `#!/usr/bin/env node
import { existsSync, writeFileSync, unlinkSync } from "node:fs";
const state = process.env.SMOKE_FIXTURE_STATE;
const stopRecord = process.env.SMOKE_FIXTURE_STOP;
const operation = process.argv[2];
if (operation === "status") {
    console.log(existsSync(state) ? "control: running" : "control: stopped");
} else if (operation === "start") {
    writeFileSync(state, "started");
    if (process.env.SMOKE_FIXTURE_FAIL_START === "1") {
        console.error("fixture-start-failed");
        process.exitCode = 7;
    } else {
        console.log("control: running");
    }
} else if (operation === "logs") {
    console.log("control server started");
} else if (operation === "stop") {
    if (existsSync(state)) unlinkSync(state);
    writeFileSync(stopRecord, "stopped");
    console.log("control: stopped");
} else {
    throw new Error("Unexpected packaged CLI command: " + operation);
}
`;

async function runPackagedFixture(failStart) {
    const fixtureRoot = await createTestTempDirectory("package-smoke-regression");
    try {
        const app = join(fixtureRoot, "fake-app");
        const bin = join(app, "bin");
        await mkdir(bin, { recursive: true });
        await writeFile(join(app, "package.json"), JSON.stringify({
            bin: { devshell: "./bin/devshell.mjs" },
            name: "fake-portable-devshell-smoke",
            type: "module",
            version: "1.0.0",
        }));
        const cli = join(bin, "devshell.mjs");
        await writeFile(cli, fixtureCli);
        await chmod(cli, 0o755);
        const archive = join(fixtureRoot, "fake-app.tar.gz");
        const tar = spawnSync("tar", ["-czf", archive, "-C", app, "."], {
            encoding: "utf8",
            windowsHide: true,
        });
        assert.equal(tar.status, 0, tar.stderr);

        const state = join(fixtureRoot, "started");
        const stopRecord = join(fixtureRoot, "stopped");
        const result = spawnSync(process.execPath, [smokeScript, "--", archive], {
            cwd: repoRoot,
            encoding: "utf8",
            env: {
                ...process.env,
                SMOKE_FIXTURE_FAIL_START: failStart ? "1" : "0",
                SMOKE_FIXTURE_STATE: state,
                SMOKE_FIXTURE_STOP: stopRecord,
            },
            timeout: 45_000,
            windowsHide: true,
        });
        return {
            ...result,
            statePresent: existsSync(state),
            stopped: existsSync(stopRecord),
        };
    } finally {
        await rm(fixtureRoot, {
            force: true,
            maxRetries: 10,
            recursive: true,
            retryDelay: 100,
        });
    }
}

test("packaged smoke drives isolated Control lifecycle and cleans up", async () => {
    const result = await runPackagedFixture(false);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /package smoke passed/u);
    assert.equal(result.stopped, true);
    assert.equal(result.statePresent, false);
});

test("failed packaged Control start still stops Control and exposes the original failure", async () => {
    const result = await runPackagedFixture(true);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /packaged devshell start failed \(7\)/u);
    assert.match(result.stderr, /fixture-start-failed/u);
    assert.equal(result.stopped, true, "a failed start may still launch the Control");
    assert.equal(result.statePresent, false);
});
