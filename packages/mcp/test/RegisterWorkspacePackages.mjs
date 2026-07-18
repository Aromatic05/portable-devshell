import { registerHooks } from "node:module";
import { after } from "node:test";

if (process.execArgv.includes("--test") || process.env.NODE_TEST_CONTEXT !== undefined) {
    installTestWatchdog();
}

function installTestWatchdog() {
    const testWatchdogTimeoutMs = Number.parseInt(process.env.PORTABLE_DEVSHELL_TEST_WATCHDOG_MS ?? "30000", 10);
    const testWatchdogOrigin = new Error("Timeout origin: global test watchdog").stack ?? "Timeout origin: global test watchdog";
    const testWatchdog = setTimeout(() => {
        const error = new Error(`global test watchdog timeout after ${testWatchdogTimeoutMs}ms\n${testWatchdogOrigin}`);
        console.error(error.stack ?? error.message);
        console.error("activeHandles", summarizeObjects(process._getActiveHandles()));
        console.error("activeRequests", summarizeObjects(process._getActiveRequests()));
        process.exit(1);
    }, testWatchdogTimeoutMs);
    testWatchdog.unref();

    after(() => {
        const handles = process._getActiveHandles();

        if (handles.length > 0 && handles.every(isStdioSocket)) {
            clearTimeout(testWatchdog);
            setImmediate(() => {
                process.exit(process.exitCode ?? 0);
            });
        }
    });

    process.once("exit", () => {
        clearTimeout(testWatchdog);
    });
}

const workspacePackages = new Map([
    ["@portable-devshell/control", new URL("../../control/src/index.ts", import.meta.url).href],
    ["@portable-devshell/control/testing", new URL("../../control/src/testing.ts", import.meta.url).href],
    ["@portable-devshell/core", new URL("../../core/src/index.ts", import.meta.url).href],
    ["@portable-devshell/core/testing", new URL("../../core/src/testing.ts", import.meta.url).href],
    ["@portable-devshell/mcp", new URL("../src/index.ts", import.meta.url).href],
    ["@portable-devshell/mcp/testing", new URL("../src/testing.ts", import.meta.url).href],
    ["@portable-devshell/shared", new URL("../../shared/src/index.ts", import.meta.url).href],
    ["@portable-devshell/shared/transport/frame", new URL("../../shared/src/transport/Frame.ts", import.meta.url).href],
    ["@portable-devshell/tui", new URL("../../tui/src/index.ts", import.meta.url).href],
    ["@portable-devshell/tui/testing", new URL("../../tui/src/testing.ts", import.meta.url).href]
]);

registerHooks({
    resolve(specifier, context, nextResolve) {
        const resolved = workspacePackages.get(specifier);

        if (resolved !== undefined) {
            return {
                shortCircuit: true,
                url: resolved
            };
        }

        return nextResolve(specifier, context);
    }
});

function summarizeObjects(items) {
    return items.map((item) => {
        if (typeof item !== "object" || item === null) {
            return String(item);
        }

        const constructorName = item.constructor?.name ?? "Unknown";
        const keys = Object.keys(item).slice(0, 5);
        return keys.length === 0 ? constructorName : `${constructorName}(${keys.join(",")})`;
    });
}

function isStdioSocket(handle) {
    return handle?.constructor?.name === "Socket" && typeof handle.fd === "number" && handle.fd >= 0 && handle.fd <= 2;
}
