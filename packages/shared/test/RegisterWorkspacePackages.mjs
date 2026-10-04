import { registerHooks } from "node:module";

const workspacePackages = new Map([
    [
        "@portable-devshell/shared",
        new URL("../src/index.ts", import.meta.url).href,
    ],
    [
        "@portable-devshell/shared/testing",
        new URL("../src/testing.ts", import.meta.url).href,
    ],
    [
        "@portable-devshell/shared/transport/frame",
        new URL("../src/transport/frame/Protocol.ts", import.meta.url).href,
    ],
    [
        "@portable-devshell/shared/config",
        new URL("../src/control/config/Type.ts", import.meta.url).href,
    ],
    [
        "@portable-devshell/shared/toolcall",
        new URL("../src/toolcall/Type.ts", import.meta.url).href,
    ],
]);

registerHooks({
    resolve(specifier, context, nextResolve) {
        const resolved = workspacePackages.get(specifier);

        if (resolved !== undefined) {
            return {
                shortCircuit: true,
                url: resolved,
            };
        }

        return nextResolve(specifier, context);
    },
});
