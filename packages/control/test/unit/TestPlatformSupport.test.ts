import assert from "node:assert/strict";
import test from "node:test";

import {
    terminalPrintCommand,
    terminalSizeProbeCommand,
    windowsTerminalUsesPowerShell,
} from "../../../../test/TestPlatformSupport.ts";

const gitBashEnvironment = {
    PORTABLE_DEVSHELL_WINDOWS_TEST_SHELL: "C:\\Program Files\\Git\\bin\\bash.exe",
};

test("Windows terminal test commands use Git Bash when the CI shell override is configured", () => {
    assert.equal(windowsTerminalUsesPowerShell("win32", gitBashEnvironment), false);
    assert.equal(
        terminalPrintCommand("git-bash-ready", 250, "win32", gitBashEnvironment),
        "sleep 0.250; printf '%s%s\\n' 'git-bas' 'h-ready'\r",
    );
    assert.equal(
        terminalSizeProbeCommand("win32", gitBashEnvironment),
        "stty size\r",
    );
});

test("Windows terminal tests keep PowerShell semantics without the explicit Git Bash override", () => {
    assert.equal(windowsTerminalUsesPowerShell("win32", {}), true);
    assert.match(
        terminalPrintCommand("powershell-ready", 0, "win32", {}),
        /powershell\.exe/u,
    );
    assert.match(terminalSizeProbeCommand("win32", {}), /powershell\.exe/u);
});
