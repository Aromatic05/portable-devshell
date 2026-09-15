import { createRequire, registerHooks, type ModuleHooks } from "node:module";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PUBLIC_EXTENSION_SDK_PACKAGE = "@portable-devshell/extension";

export interface ExtensionHostModuleLease {
    release(): void;
}

export interface ExtensionHostModuleResolverOptions {
    deniedSpecifiers?: readonly string[];
}

interface ExtensionHostModuleRoot {
    count: number;
    hostDependencies: Set<string>;
}

/**
 * Allows Extension generations to reuse the application's Node dependency tree.
 *
 * Resolution stays local-first: Node resolves relative files and any dependency
 * shipped inside the generation normally. Only a missing bare package import
 * from a registered generation falls back to the Control application's module
 * graph. Sandboxed generations install the resolver inside their own worker
 * thread, so dependency fallback does not require importing Extension code into
 * the Control main thread.
 */
export class ExtensionHostModuleResolver {
    readonly #roots = new Map<string, ExtensionHostModuleRoot>();
    readonly #hooks: ModuleHooks;
    readonly #hostParentUrl: string;
    readonly #hostRequire: ReturnType<typeof createRequire>;
    readonly #deniedSpecifiers: ReadonlySet<string>;

    constructor(
        hostParentUrl: string = import.meta.url,
        options: ExtensionHostModuleResolverOptions = {}
    ) {
        this.#hostParentUrl = hostParentUrl;
        this.#hostRequire = createRequire(hostParentUrl);
        this.#deniedSpecifiers = new Set(options.deniedSpecifiers ?? []);
        this.#hooks = registerHooks({
            resolve: (specifier, context, nextResolve) => {
                if (this.#deniedSpecifiers.has(specifier)) {
                    throw new Error(`Extension generation cannot import restricted module ${specifier}.`);
                }
                const registeredRoot = isBareSpecifier(specifier)
                    ? this.#rootForParent(context.parentURL)
                    : undefined;
                const requestedPackage = packageRoot(specifier);
                if (
                    registeredRoot !== undefined
                    && requestedPackage?.startsWith("@portable-devshell/") === true
                    && requestedPackage !== PUBLIC_EXTENSION_SDK_PACKAGE
                ) {
                    throw new Error(
                        `Extension generation cannot import portable-devshell internal package ${requestedPackage}.`
                    );
                }
                if (registeredRoot !== undefined && requestedPackage === PUBLIC_EXTENSION_SDK_PACKAGE) {
                    try {
                        return nextResolve(specifier, { ...context, parentURL: this.#hostParentUrl });
                    } catch (error) {
                        try {
                            return {
                                shortCircuit: true,
                                url: pathToFileURL(this.#hostRequire.resolve(specifier)).href
                            };
                        } catch {
                            throw error;
                        }
                    }
                }
                try {
                    return nextResolve(specifier, context);
                } catch (error) {
                    if (
                        registeredRoot === undefined
                        || requestedPackage === undefined
                        || !registeredRoot.hostDependencies.has(requestedPackage)
                    ) {
                        throw error;
                    }
                    try {
                        return nextResolve(specifier, { ...context, parentURL: this.#hostParentUrl });
                    } catch {
                        try {
                            return {
                                shortCircuit: true,
                                url: pathToFileURL(this.#hostRequire.resolve(specifier)).href
                            };
                        } catch {
                            throw error;
                        }
                    }
                }
            }
        });
    }

    register(codeDirectory: string, hostDependencies: readonly string[] = []): ExtensionHostModuleLease {
        const root = resolve(codeDirectory);
        const existing = this.#roots.get(root);
        if (existing === undefined) {
            this.#roots.set(root, {
                count: 1,
                hostDependencies: new Set(hostDependencies)
            });
        } else {
            existing.count += 1;
            for (const dependency of hostDependencies) existing.hostDependencies.add(dependency);
        }
        let released = false;
        return {
            release: () => {
                if (released) return;
                released = true;
                const registration = this.#roots.get(root);
                if (registration === undefined || registration.count <= 1) this.#roots.delete(root);
                else registration.count -= 1;
            }
        };
    }

    dispose(): void {
        this.#roots.clear();
        this.#hooks.deregister();
    }

    #rootForParent(parentUrl: string | undefined): ExtensionHostModuleRoot | undefined {
        if (parentUrl === undefined || !parentUrl.startsWith("file:")) return undefined;
        let parentPath: string;
        try {
            parentPath = fileURLToPath(parentUrl);
        } catch {
            return undefined;
        }
        for (const [root, registration] of this.#roots) {
            const candidate = relative(root, parentPath);
            if (candidate === "" || (!candidate.startsWith("..") && !isAbsolute(candidate))) {
                return registration;
            }
        }
        return undefined;
    }
}

let sharedResolver: ExtensionHostModuleResolver | undefined;

export function sharedExtensionHostModuleResolver(): ExtensionHostModuleResolver {
    sharedResolver ??= new ExtensionHostModuleResolver();
    return sharedResolver;
}

function isBareSpecifier(specifier: string): boolean {
    return !specifier.startsWith(".")
        && !specifier.startsWith("/")
        && !specifier.startsWith("#")
        && !/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(specifier);
}

function packageRoot(specifier: string): string | undefined {
    if (!isBareSpecifier(specifier)) return undefined;
    const segments = specifier.split("/");
    if (specifier.startsWith("@")) {
        return segments.length >= 2 && segments[0]!.length > 1 && segments[1]!.length > 0
            ? `${segments[0]}/${segments[1]}`
            : undefined;
    }
    return segments[0]?.length === 0 ? undefined : segments[0];
}
