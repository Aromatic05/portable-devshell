import { createRequire, registerHooks } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const AGENT_PROVIDER_MODULE_ROOT_ENV =
    "PORTABLE_DEVSHELL_AGENT_PROVIDER_MODULE_ROOT";
export const AGENT_PROVIDER_HOST_MODULE_ROOT_ENV =
    "PORTABLE_DEVSHELL_AGENT_HOST_MODULE_ROOT";

const root = process.env[AGENT_PROVIDER_MODULE_ROOT_ENV];
const hostRoot = process.env[AGENT_PROVIDER_HOST_MODULE_ROOT_ENV];
if (root !== undefined && root.length > 0) {
    registerAgentProviderModuleResolver(
        root,
        hostRoot === undefined || hostRoot.length === 0 ? undefined : hostRoot,
    );
}

export function registerAgentProviderModuleResolver(
    providerRoot: string,
    coreRoot?: string,
): void {
    const requireFromProvider = createRequire(
        join(providerRoot, "package.json"),
    );
    const requireFromHost =
        coreRoot === undefined
            ? undefined
            : createRequire(join(coreRoot, "package.json"));
    registerHooks({
        resolve(specifier, context, nextResolve) {
            try {
                return nextResolve(specifier, context);
            } catch (error) {
                if (!isBareSpecifier(specifier)) throw error;
                const fallback = isDevshellInternal(specifier)
                    ? requireFromHost
                    : requireFromProvider;
                if (fallback === undefined) throw error;
                try {
                    return {
                        shortCircuit: true,
                        url: pathToFileURL(fallback.resolve(specifier)).href,
                    };
                } catch {
                    throw error;
                }
            }
        },
    });
}

function isBareSpecifier(specifier: string): boolean {
    return (
        !specifier.startsWith(".") &&
        !specifier.startsWith("/") &&
        !specifier.startsWith("node:") &&
        !specifier.startsWith("file:")
    );
}

function isDevshellInternal(specifier: string): boolean {
    return specifier.startsWith("@portable-devshell/");
}
