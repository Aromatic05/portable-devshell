import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/beta-matrix-extended.yml", import.meta.url), "utf8");
const suites = ["upgrade", "extension", "workflow", "windows-psmux"];

test("extended beta verification is explicit, not a pull request gate", () => {
    assert.match(workflow, /workflow_dispatch:/u);
    assert.doesNotMatch(workflow, /(?:^|\n)\s*(?:pull_request:|push:|schedule:)/u);
    for (const suite of suites) assert.ok(workflow.includes("- " + suite + "\n"));
});

test("extended Testspace commands use private root and always attempt shutdown", () => {
    assert.match(workflow, /DEVSHELL_TESTSPACE_ROOT:\s*\$\{\{ runner\.temp \}\}\/beta-matrix-/u);
    for (const subcommand of [
        "upgrade-smoke", "extension-smoke", "workflow-smoke", "approval-smoke", "mailing-smoke",
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
