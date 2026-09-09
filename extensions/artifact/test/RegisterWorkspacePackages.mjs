import { registerHooks } from "node:module";

const workspacePackages = new Map([
    ["@portable-devshell/extension", new URL("../../../packages/extension/src/index.ts", import.meta.url).href],
    ["@portable-devshell/extension/artifact", new URL("../../../packages/extension/src/domain/artifact.ts", import.meta.url).href],
    ["@portable-devshell/extension/cli", new URL("../../../packages/extension/src/domain/cli.ts", import.meta.url).href]
]);

registerHooks({
    resolve(specifier, context, nextResolve) {
        const resolved = workspacePackages.get(specifier);
        if (resolved !== undefined) return { shortCircuit: true, url: resolved };
        return nextResolve(specifier, context);
    }
});
