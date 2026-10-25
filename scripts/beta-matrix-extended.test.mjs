import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/beta-matrix-extended.yml", import.meta.url), "utf8");
const suites = ["upgrade", "extension", "workflow", "recovery", "retirement", "browser", "handoff", "chains", "windows-psmux"];

test("extended beta verification is explicit, not a pull request gate", () => {
    assert.match(workflow, /workflow_dispatch:/u);
    assert.doesNotMatch(workflow, /(?:^|\n)\s*(?:pull_request:|push:|schedule:)/u);
    for (const suite of suites) assert.ok(workflow.includes("- " + suite + "\n"));
});

test("extended Testspace commands use private root and always attempt shutdown", () => {
    assert.match(workflow, /DEVSHELL_TESTSPACE_ROOT=\$RUNNER_TEMP\/beta-matrix-\$GITHUB_RUN_ID-\$GITHUB_RUN_ATTEMPT/u);
    assert.match(workflow, />> "\$GITHUB_ENV"/u);
    assert.doesNotMatch(workflow, /DEVSHELL_TESTSPACE_ROOT:\s*\$\{\{ runner\.temp \}\}/u);
    for (const subcommand of [
        "upgrade-smoke", "extension-smoke", "workflow-smoke", "approval-smoke", "mailing-smoke", "recovery-smoke", "retirement-smoke",
    ]) assert.ok(workflow.includes("pnpm testspace " + subcommand));
    assert.match(workflow, /pnpm testspace start --skip-build/u);
    assert.match(workflow, /if: always\(\).*inputs\.suite/u);
    assert.match(workflow, /pnpm testspace stop/u);
});

test("Windows PSMUX runtime contracts run natively on x64 and ARM64", () => {
    assert.match(workflow, /runner: windows-2022/u);
    assert.match(workflow, /runner: windows-11-arm/u);
    assert.match(workflow, /cargo test --locked -p devshell-worker --test tmux_windows_contract/u);
    assert.match(workflow, /shell: pwsh/u);
});

test("recovery manual dispatch builds, starts and always stops the dedicated Testspace", () => {
    assert.match(workflow, /options:[\s\S]*?\n\s+- recovery\n/u);
    const step = (name) => {
        const start = workflow.indexOf("            - name: " + name + "\n");
        assert.notEqual(start, -1, `Missing workflow step: ${name}`);
        const end = workflow.indexOf("            - name:", start + 1);
        return workflow.slice(start, end === -1 ? workflow.length : end);
    };
    for (const name of ["Build isolated Testspace runtime", "Start isolated Control and Workers", "Stop isolated Testspace"])
        assert.match(step(name), /inputs\.suite == 'recovery'/u);
    assert.match(step("Build isolated Testspace runtime"), /pnpm build\n\s+pnpm test:prepare/u);
    assert.match(step("Start isolated Control and Workers"), /pnpm testspace start --skip-build/u);
    const recovery = step("Restart, audit persistence and stream gap recovery");
    assert.match(recovery, /if: inputs\.suite == 'recovery'/u);
    assert.match(recovery, /shell: bash/u);
    assert.match(recovery, /pnpm testspace recovery-smoke 2>&1 \| tee "\$RUNNER_TEMP\/beta-matrix-recovery\.log"/u);
    assert.match(step("Stop isolated Testspace"), /if: always\(\)/u);
    assert.match(step("Stop isolated Testspace"), /pnpm testspace stop/u);
    assert.match(step("Upload isolated Testspace logs"), /\$\{\{ runner\.temp \}\}\/beta-matrix-recovery\.log/u);
    assert.ok(workflow.indexOf(recovery) < workflow.indexOf("            - name: Stop isolated Testspace"));
});


test("retirement manual dispatch builds, runs isolated Worker lifetime test and always stops", () => {
    const step = (name) => {
        const start = workflow.indexOf("            - name: " + name + "\n");
        assert.notEqual(start, -1, "Missing retirement step: " + name);
        const end = workflow.indexOf("            - name:", start + 1);
        return workflow.slice(start, end === -1 ? workflow.length : end);
    };
    for (const name of ["Build isolated Testspace runtime", "Start isolated Control and Workers", "Stop isolated Testspace"]) {
        assert.ok(step(name).includes("inputs.suite == 'retirement'"), name + " missing retirement");
    }
    const retirement = step("Verify worker retirement after Control restart");
    assert.ok(retirement.includes("inputs.suite == 'retirement'"));
    assert.ok(retirement.includes("pnpm testspace retirement-smoke 2>&1 | tee"));
    assert.ok(retirement.includes("beta-matrix-retirement.log"));
    assert.ok(workflow.indexOf(retirement) < workflow.indexOf("            - name: Stop isolated Testspace"));
    assert.ok(step("Stop isolated Testspace").includes("always()"));
    assert.ok(step("Upload isolated Testspace logs").includes("beta-matrix-retirement.log"));
});


test("browser and long-handoff optional suites use fresh AcceptanceFixture and do not join Testspace", () => {
    const step = (name) => {
        const start = workflow.indexOf("            - name: " + name + "\n");
        assert.ok(start >= 0, "missing suite step: " + name);
        const end = workflow.indexOf("            - name:", start + 1);
        return workflow.slice(start, end === -1 ? workflow.length : end);
    };
    const build = step("Build isolated Testspace runtime");
    for (const suite of ["browser", "handoff"]) {
        assert.ok(build.includes("inputs.suite == '" + suite + "'"));
        assert.doesNotMatch(step("Start isolated Control and Workers"), new RegExp("inputs\.suite == '" + suite + "'"));
        assert.doesNotMatch(step("Stop isolated Testspace"), new RegExp("inputs\.suite == '" + suite + "'"));
    }
    const browser = step("Real Chromium browser Audit replay and Instance stop-start");
    assert.ok(browser.includes("inputs.suite == 'browser'"));
    assert.ok(browser.includes("pnpm acceptance:web 2>&1 | tee"));
    const handoff = step("Real 190-second tmux handoff and recovery");
    assert.ok(handoff.includes("inputs.suite == 'handoff'"));
    assert.ok(handoff.includes("pnpm acceptance:tmux-handoff 2>&1 | tee"));
    assert.match(step("Upload isolated Testspace logs"), /beta-matrix-browser\.log/u);
    assert.match(step("Upload isolated Testspace logs"), /beta-matrix-handoff\.log/u);
    const source = readFileSync(new URL("../acceptance/AcceptanceSupport.mjs", import.meta.url), "utf8");
    assert.match(source, /createTestTempDirectory\("acceptance"\)/u);
    assert.match(source, /await rm\(root, \{ force: true, recursive: true \}\)/u);
});


test("chains suite runs real AcceptanceFixture programs independently of shared Testspace", () => {
    const step = (name) => {
        const start = workflow.indexOf("            - name: " + name + "\n");
        assert.ok(start >= 0, "missing step: " + name);
        const end = workflow.indexOf("            - name:", start + 1);
        return workflow.slice(start, end < 0 ? workflow.length : end);
    };
    assert.ok(step("Build isolated Testspace runtime").includes("inputs.suite == 'chains'"));
    assert.equal(step("Start isolated Control and Workers").includes("inputs.suite == 'chains'"), false);
    assert.equal(step("Stop isolated Testspace").includes("inputs.suite == 'chains'"), false);
    const chromium = step("Install Chromium for multi-client chain");
    assert.ok(chromium.includes("inputs.suite == 'chains'"));
    assert.ok(chromium.includes("playwright install --with-deps chromium"));
    assert.ok(chromium.includes("PORTABLE_DEVSHELL_REQUIRE_CHROMIUM=1"));
    const run = step("Four complete functional chain acceptance tests");
    assert.ok(run.includes("set -o pipefail"));
    assert.ok(run.includes("node acceptance/run-chain-matrix.mjs --all 2>&1 | tee"));
    assert.ok(run.includes("inputs.suite == 'chains'"));
    assert.ok(step("Upload isolated Testspace logs").includes("beta-matrix-chains.log"));
});
