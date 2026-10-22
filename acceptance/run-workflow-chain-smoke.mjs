#!/usr/bin/env node
// Entry: node acceptance/run-workflow-chain-smoke.mjs
// ~3-5 minutes on a normal host. Exit 0 = complete chain; 1 = failure;
// exit 2 = listen EPERM/EACCES before services start (environment blocked).
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkflowFixture } from "./chains/WorkflowSupport.mjs";
import { runWorkflowPersistentChain } from "./chains/WorkflowPersistentChain.mjs";

const evidence = mkdtempSync(join(tmpdir(), "workflow-chain-evidence-"));
const phases = [];
const requiredPhases = ["control-worker-ready", "persistent-goal-created", "action-error-recovery-and-replay",
    "wait-detached-durable", "restart-one-directive-claimed", "restart-two-attempt-replay-fenced",
    "terminal-wait-goal-verified", "sqlite-audit-events-verified"];
function record(phase, detail = {}) {
    phases.push(phase);
    appendFileSync(join(evidence, "phases.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), phase, ...detail })}\n`);
    process.stdout.write(`[L05-workflow] ${phase}\n`);
}
let fixture;
const summary = { status: "running", evidence, phases, hostDelivery: "not-sent", result: null, error: null, cleanupError: null };
try {
    record("preflight");
    fixture = await createWorkflowFixture(record);
    record("isolated-fixture-created", { root: fixture.root });
    summary.result = await runWorkflowPersistentChain(fixture, record);
    const missing = requiredPhases.filter(phase => !phases.includes(phase));
    if (missing.length > 0) throw new Error(`Required workflow phases were not verified: ${missing.join(", ")}`);
    summary.status = "passed";
} catch (error) {
    summary.error = error.stack ?? String(error);
    summary.status = !fixture && ["EPERM", "EACCES"].includes(error.code) ? "environment-blocked" : "failed";
    process.exitCode = summary.status === "environment-blocked" ? 2 : 1;
    process.stderr.write(`${summary.status}: ${summary.error}\n`);
} finally {
    if (fixture) {
        try {
            await fixture.cleanup();
            record("isolated-fixture-cleaned");
        } catch (error) {
            summary.cleanupError = error.stack ?? String(error);
            summary.status = "failed";
            process.exitCode = 1;
            process.stderr.write(`cleanup failed: ${summary.cleanupError}\n`);
        }
    }
    summary.exit = process.exitCode ?? 0;
    summary.unreached = requiredPhases.filter((phase) => !phases.includes(phase));
    writeFileSync(join(evidence, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}
