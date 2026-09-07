import { registerHooks } from "node:module";
import { after } from "node:test";

if (process.execArgv.includes("--test") || process.env.NODE_TEST_CONTEXT !== undefined) {
    installTestWatchdog();
}

function installTestWatchdog() {
    const testWatchdogTimeoutMs = Number.parseInt(process.env.PORTABLE_DEVSHELL_TEST_WATCHDOG_MS ?? "30000", 10);
    const testWatchdog = setTimeout(() => {
        console.error(new Error(`global test watchdog timeout after ${testWatchdogTimeoutMs}ms`).stack);
        process.exit(1);
    }, testWatchdogTimeoutMs);
    testWatchdog.unref();
    after(() => clearTimeout(testWatchdog));
    process.once("exit", () => clearTimeout(testWatchdog));
}

const workspacePackages = new Map([
    ["@portable-devshell/agentd", new URL("../../agentd/src/index.ts", import.meta.url).href],
    ["@portable-devshell/pi-extension", new URL("../../pi-extension/src/index.ts", import.meta.url).href],
    ["@portable-devshell/shared", new URL("../../shared/src/index.ts", import.meta.url).href],
    ["@portable-devshell/shared/transport/frame", new URL("../../shared/src/transport/protocol/Frame.ts", import.meta.url).href]
]);

registerHooks({
    resolve(specifier, context, nextResolve) {
        const resolved = workspacePackages.get(specifier);
        if (resolved !== undefined) return { shortCircuit: true, url: resolved };
        return nextResolve(specifier, context);
    }
});
