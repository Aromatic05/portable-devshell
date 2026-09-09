import { existsSync, readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";

const workspacePackages = new Map([
    ["@portable-devshell/extension", new URL("../../../../../../../extension/src/index.ts", import.meta.url).href],
    ["@portable-devshell/extension/artifact", new URL("../../../../../../../extension/src/domain/artifact.ts", import.meta.url).href],
    ["@portable-devshell/extension/cli", new URL("../../../../../../../extension/src/domain/cli.ts", import.meta.url).href],
    ["@portable-devshell/extension/instance", new URL("../../../../../../../extension/src/domain/instance.ts", import.meta.url).href],
    ["@portable-devshell/extension/web", new URL("../../../../../../../extension/src/domain/web.ts", import.meta.url).href],
    ["@portable-devshell/shared", new URL("../../../../../../../shared/src/index.ts", import.meta.url).href],
    ["@portable-devshell/shared/transport/frame", new URL("../../../../../../../shared/src/transport/protocol/Frame.ts", import.meta.url).href]
]);

registerHooks({
    resolve(specifier, context, nextResolve) {
        const workspace = workspacePackages.get(specifier);
        if (workspace !== undefined) return { shortCircuit: true, url: workspace };

        if (
            context.parentURL?.startsWith("file:") === true
            && (specifier.startsWith("./") || specifier.startsWith("../"))
            && specifier.endsWith(".js")
        ) {
            const candidate = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
            if (existsSync(candidate)) return { shortCircuit: true, url: candidate.href };
        }

        return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
        if (!url.startsWith("file:") || !url.endsWith(".ts")) return nextLoad(url, context);
        const source = readFileSync(new URL(url), "utf8");
        return {
            format: "module",
            shortCircuit: true,
            source: stripTypeScriptTypes(source, {
                mode: "transform",
                sourceMap: false,
                sourceUrl: url
            })
        };
    }
});
