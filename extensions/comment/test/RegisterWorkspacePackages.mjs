import { registerHooks } from "node:module";

const workspacePackages = new Map([
    ["@portable-devshell/extension", new URL("../../../packages/extension/src/index.ts", import.meta.url).href],
    ["@portable-devshell/extension/comment", new URL("../../../packages/extension/src/domain/comment.ts", import.meta.url).href],
    ["@portable-devshell/extension/toolcall", new URL("../../../packages/extension/src/domain/toolcall.ts", import.meta.url).href],
    ["@portable-devshell/shared", new URL("../../../packages/shared/src/index.ts", import.meta.url).href],
]);

registerHooks({
    resolve(specifier, context, nextResolve) {
        const resolved = workspacePackages.get(specifier);
        return resolved === undefined ? nextResolve(specifier, context) : { shortCircuit: true, url: resolved };
    },
});
