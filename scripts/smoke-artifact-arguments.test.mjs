import assert from "node:assert/strict";
import test from "node:test";

import {
    resolveAgentSmokeArtifacts,
    resolveApplicationSmokeArchive
} from "./smoke-artifact-arguments.mjs";

test("application smoke defaults to the current host release asset", () => {
    assert.equal(
        resolveApplicationSmokeArchive([], "/repo", "linux", "x64"),
        "/repo/release-assets/portable-devshell-app-linux-x64.tar.gz"
    );
    assert.equal(resolveApplicationSmokeArchive(["--", "./custom.tar.gz"], "/repo", "linux", "x64"), "/repo/custom.tar.gz");
    assert.throws(() => resolveApplicationSmokeArchive(["a", "b"], "/repo", "linux", "x64"), /at most one/u);
});

test("Agent smoke defaults every artifact to one host release target", () => {
    assert.deepEqual(resolveAgentSmokeArtifacts([], "/repo", "linux", "x64"), [
        "/repo/release-assets/portable-devshell-app-linux-x64.tar.gz",
        "/repo/release-assets/portable-devshell-agent.dsext",
        "/repo/release-assets/portable-devshell-agent-provider-pi-linux-x64.dsprovider",
        "/repo/release-assets/portable-devshell-agent-provider-opencode-linux-x64.dsprovider",
        "/repo/release-assets/devshell-worker-linux-x64"
    ]);
    assert.deepEqual(resolveAgentSmokeArtifacts([], "C:\\repo", "win32", "x64").map((path) => path.replaceAll("\\", "/")), [
        "C:/repo/release-assets/portable-devshell-app-windows-x64.tar.gz",
        "C:/repo/release-assets/portable-devshell-agent.dsext",
        "C:/repo/release-assets/portable-devshell-agent-provider-pi-windows-x64.dsprovider",
        "C:/repo/release-assets/portable-devshell-agent-provider-opencode-windows-x64.dsprovider",
        "C:/repo/release-assets/devshell-worker-windows-x64.exe"
    ]);
    assert.throws(() => resolveAgentSmokeArtifacts(["only-one"], "/repo", "linux", "x64"), /either no arguments or/u);
});
