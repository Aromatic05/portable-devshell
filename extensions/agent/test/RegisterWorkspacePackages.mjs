import { registerHooks } from "node:module";
import { after } from "node:test";

if (process.execArgv.includes("--test") || process.env.NODE_TEST_CONTEXT !== undefined) {
    installTestWatchdog();
}

function installTestWatchdog() {
    const timeoutMs = Number.parseInt(process.env.PORTABLE_DEVSHELL_TEST_WATCHDOG_MS ?? "30000", 10);
    const watchdog = setTimeout(() => {
        console.error(new Error(`global test watchdog timeout after ${timeoutMs}ms`).stack);
        process.exit(1);
    }, timeoutMs);
    watchdog.unref();
    after(() => clearTimeout(watchdog));
    process.once("exit", () => clearTimeout(watchdog));
}

const workspacePackages = new Map([
    ["@portable-devshell/extension", new URL("../../../packages/extension/src/index.ts", import.meta.url).href],
    ["@portable-devshell/shared", new URL("../../../packages/shared/src/index.ts", import.meta.url).href],
    ["@portable-devshell/shared/transport/frame", new URL("../../../packages/shared/src/transport/protocol/Frame.ts", import.meta.url).href]
]);

registerHooks({
    resolve(specifier, context, nextResolve) {
        const resolved = workspacePackages.get(specifier);
        if (resolved !== undefined) return { shortCircuit: true, url: resolved };
        return nextResolve(specifier, context);
    }
});
