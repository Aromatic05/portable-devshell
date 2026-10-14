import { registerHooks } from "node:module";
registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier === "@portable-devshell/extension") return { shortCircuit: true, url: new URL("../../../packages/extension/src/index.ts", import.meta.url).href };
        return nextResolve(specifier, context);
    },
});
