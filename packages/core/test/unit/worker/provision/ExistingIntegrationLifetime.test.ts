import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import { existingId } from "./ExistingHarness.ts";
import { fixture } from "./ExistingIntegrationFixture.ts";

const posix = { skip: process.platform === "win32" ? "requires POSIX provider fixture" : false };

test("Existing integration: independent instance databases exclude concurrent cross-process starts of one physical ID", posix, async (t) => {
    const f = await fixture(t);
    await f.faults([{ operation: "start", gate: true }]);
    const first = f.run("start");
    let entered = false;
    for (let attempt = 0; attempt < 200; attempt++) {
        entered = await readFile(join(f.root, "gate-entered"), "utf8").then(() => true, (error: NodeJS.ErrnoException) => {
            assert.equal(error.code, "ENOENT");
            return false;
        });
        if (entered) break;
        await setTimeout(10);
    }
    let second;
    try {
        assert.equal(entered, true);
        second = await f.run("start", "second-instance");
    } finally {
        await writeFile(join(f.root, "gate-release"), "");
    }
    const started = await first;
    assert.equal(started.code, 0, started.stderr);
    assert.equal(second.code, 1, second.stderr);
    assert.match(second.stderr, /database is locked/u);
    assert.ok(await f.record());
    assert.equal(await f.record("second"), undefined);
    assert.equal((await f.run("start", "second-instance")).code, 1);
    assert.equal((await f.run("retire-skip", "second-instance")).code, 0);
    assert.equal((await f.run("status")).code, 0);
    assert.deepEqual((await f.calls()).filter(([operation]) => operation === "start"), [["start", existingId]]);
    assert.equal((await f.run("retire-all")).code, 0);
    const next = await f.run("start", "second-instance");
    assert.equal(next.code, 0, next.stderr);
    assert.ok(await f.record("second"));
    assert.deepEqual((await f.states()).neighbor, f.neighbor);
});

for (const command of ["stop", "retire"]) {
    test(`Existing integration: native ${command} failure retains live SQLite adoption and a fresh process completes retirement`, posix, async (t) => {
        const f = await fixture(t);
        assert.equal((await f.run("start", "worker-only")).code, 0);
        const provenance = await f.record();
        assert.ok(provenance);
        await f.nativeFaults([{ command, code: 23 }]);
        const failed = await f.run("retire-all", "worker-only");
        assert.equal(failed.code, 1);
        assert.match(failed.stderr, /incomplete/u);
        assert.deepEqual(await f.record(), provenance);
        assert.equal((await f.states()).configured?.State.Status, "running");
        assert.equal((await f.run("status", "worker-only")).code, 0);
        const retry = await f.run("retire-all", "worker-only");
        assert.equal(retry.code, 0, retry.stderr);
        assert.equal(await f.record(), undefined);
        assert.equal((await f.run("status", "worker-only")).code, 1);
        assert.deepEqual((await f.states()).neighbor, f.neighbor);
    });
}

test("Existing integration: fresh skip-runtime retirement revokes SQLite provenance and cannot reattach", posix, async (t) => {
    const f = await fixture(t);
    assert.equal((await f.run("start", "worker-only")).code, 0);
    assert.equal((await f.run("retire-skip", "worker-only")).code, 0);
    assert.equal(await f.record(), undefined);
    assert.equal((await f.run("status", "worker-only")).code, 1);
    assert.equal((await f.states()).configured?.State.Status, "running");
    assert.deepEqual((await f.states()).neighbor, f.neighbor);
});

test("Existing integration: temporary start clears native stale PID and failed physical stop preserves retry provenance", posix, async (t) => {
    const f = await fixture(t);
    await writeFile(join(f.root, "workers.json"), JSON.stringify({ adopted: "stale", neighbor: "running" }));
    await f.faults([{ operation: "stop", code: 47 }]);
    const failed = await f.run("retire-all");
    assert.equal(failed.code, 1);
    assert.match(failed.stderr, /incomplete/u);
    const provenance = await f.record();
    assert.ok(provenance);
    assert.equal(provenance.retiring, true);
    assert.deepEqual((await f.nativeCalls()).map(([command]) => command), ["stop", "retire"]);
    assert.equal((await f.states()).configured?.State.Status, "running");
    const retried = await f.run("retire-all");
    assert.equal(retried.code, 0, retried.stderr);
    assert.equal((await f.states()).configured?.State.Status, "stopped");
    assert.equal(await f.record(), undefined);
    assert.deepEqual(JSON.parse(await readFile(join(f.root, "workers.json"), "utf8")), { neighbor: "running" });
    assert.deepEqual((await f.states()).neighbor, f.neighbor);
});
