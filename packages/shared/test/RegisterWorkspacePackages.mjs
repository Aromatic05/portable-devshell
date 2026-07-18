import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { registerHooks } from "node:module";

const workspacePackages = new Map([
    ["@portable-devshell/shared", new URL("../src/index.ts", import.meta.url).href],
    ["@portable-devshell/shared/transport/frame", new URL("../src/transport/Frame.ts", import.meta.url).href],
]);

registerHooks({
    resolve(specifier, context, nextResolve) {
        const resolved = workspacePackages.get(specifier) ?? resolveSourceModule(specifier, context.parentURL);

        if (resolved !== undefined) {
            return {
                shortCircuit: true,
                url: resolved
            };
        }

        return nextResolve(specifier, context);
    }
});

function resolveSourceModule(specifier, parentURL) {
    if (parentURL === undefined || !parentURL.includes("/src/") || !specifier.startsWith(".") || !specifier.endsWith(".js")) {
        return undefined;
    }
    const javascriptURL = new URL(specifier, parentURL);
    for (const extension of [".ts", ".tsx"]) {
        const candidate = new URL(javascriptURL.href.replace(/\.js$/u, extension));
        if (existsSync(fileURLToPath(candidate))) {
            return candidate.href;
        }
    }
    return undefined;
}
