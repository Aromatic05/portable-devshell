import { registerHooks } from "node:module";

const workspacePackages = new Map([
    [
        "@portable-devshell/extension",
        new URL("../../../packages/extension/src/index.ts", import.meta.url)
            .href,
    ],
    [
        "@portable-devshell/extension/secret",
        new URL("../../../packages/extension/src/domain/secret.ts", import.meta.url)
            .href,
    ],
    [
        "@portable-devshell/extension/toolcall",
        new URL("../../../packages/extension/src/domain/toolcall.ts", import.meta.url)
            .href,
    ],
]);

registerHooks({
    resolve(specifier, context, nextResolve) {
        const resolved = workspacePackages.get(specifier);
        if (resolved !== undefined)
            return { shortCircuit: true, url: resolved };
        return nextResolve(specifier, context);
    },
});
