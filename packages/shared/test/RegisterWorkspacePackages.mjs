import { registerHooks } from "node:module";

const workspacePackages = new Map([
    ["@portable-devshell/shared", new URL("../src/index.ts", import.meta.url).href],
    ["@portable-devshell/shared/transport/frame", new URL("../src/transport/Frame.ts", import.meta.url).href],
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
