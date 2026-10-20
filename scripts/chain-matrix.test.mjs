import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import { functionalChains, runFunctionalChains, selectFunctionalChains } from "../acceptance/run-chain-matrix.mjs";

test("all four end-to-end chains are explicit, isolated executables with bounded runtime", () => {
    assert.deepEqual(functionalChains.map((entry) => entry.id), ["L07", "L05", "L03", "L01-L04"]);
    for (const chain of functionalChains) {
        assert.match(chain.file, /^acceptance\/run-[a-z-]+-chain-smoke\.mjs$/u);
        assert.equal(chain.timeoutMs >= 180_000 && chain.timeoutMs <= 600_000, true);
    }
    assert.deepEqual(selectFunctionalChains([]), functionalChains);
    assert.deepEqual(selectFunctionalChains(["--all"]), functionalChains);
    assert.equal(selectFunctionalChains(["--only", "L05"])[0]?.id, "L05");
    assert.throws(() => selectFunctionalChains(["--only", "L08"]), /Unknown chain selection/u);
    assert.throws(() => selectFunctionalChains(["--only", "L07", "--all"]), /Unknown chain selection/u);
});

test("chain runner executes all chains even when an earlier chain fails", () => {
    const called = [];
    const result = runFunctionalChains(functionalChains, {
        execute(chain) {
            called.push(chain.id);
            if (chain.id === "L07") return { status: 9 };
            return { status: 0 };
        },
        log() {},
    });
    assert.deepEqual(called, functionalChains.map((item) => item.id));
    assert.equal(result.ok, false);
    assert.deepEqual(result.failures, [{ name: "L07: Artifact cross-worker lifecycle", status: 9 }]);
    assert.deepEqual(result.testedChains, ["L07", "L05", "L03", "L01-L04"]);
});

test("uncertain or throwing chain results fail the matrix rather than counting as skipped", () => {
    const result = runFunctionalChains(functionalChains, {
        execute(chain) {
            if (chain.id === "L05") throw new Error("isolated process failed");
            if (chain.id === "L03") return { status: undefined };
            return { status: 0 };
        },
        log() {},
    });
    assert.deepEqual(result.failures.map((entry) => entry.name), [
        "L05: Workspace wait and reentry recovery",
        "L03: Multi-client authoritative consistency",
    ]);
    assert.equal(result.ok, false);
    assert.equal(result.completed, 4);
});

test("empty matrix never reports a successful acceptance", () => {
    assert.throws(() => runFunctionalChains([], { log() {} }), /No functional chains selected/u);
});

test("selection uses fixed entrypoints, not arbitrary paths or shell input", () => {
    for (const chain of functionalChains) {
        assert.ok(chain.file.startsWith("acceptance/"));
        assert.notEqual(chain.file.includes(".."), true);
    }
    assert.throws(() => selectFunctionalChains(["--only", "../../.devshell"]), /Unknown chain selection/u);
    assert.ok(existsSync("acceptance/run-chain-matrix.mjs"));
});
