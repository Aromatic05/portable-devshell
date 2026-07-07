import { registerHooks } from "node:module";

const workspacePackages = new Map([
    ["@portable-devshell/shared", new URL("../dist/index.js", import.meta.url).href]
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
