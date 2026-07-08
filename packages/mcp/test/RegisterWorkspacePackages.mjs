import { registerHooks } from "node:module";

const workspacePackages = new Map([
    ["@portable-devshell/control", new URL("../../control/dist/index.js", import.meta.url).href],
    ["@portable-devshell/core", new URL("../../core/dist/index.js", import.meta.url).href],
    ["@portable-devshell/mcp", new URL("../dist/index.js", import.meta.url).href],
    ["@portable-devshell/shared", new URL("../../shared/dist/index.js", import.meta.url).href]
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
