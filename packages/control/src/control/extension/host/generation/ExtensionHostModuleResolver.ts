import { createRequire, registerHooks, type ModuleHooks } from "node:module";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface ExtensionHostModuleLease {
    release(): void;
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
    readonly #roots = new Map<string, number>();
    readonly #hooks: ModuleHooks;
    readonly #hostParentUrl: string;
    readonly #hostRequire: ReturnType<typeof createRequire>;

    constructor(hostParentUrl: string = import.meta.url) {
        this.#hostParentUrl = hostParentUrl;
        this.#hostRequire = createRequire(hostParentUrl);
        this.#hooks = registerHooks({
            resolve: (specifier, context, nextResolve) => {
                try {
                    return nextResolve(specifier, context);
                } catch (error) {
                    if (!isBareSpecifier(specifier) || !this.#containsParent(context.parentURL)) throw error;
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

    register(codeDirectory: string): ExtensionHostModuleLease {
        const root = resolve(codeDirectory);
        this.#roots.set(root, (this.#roots.get(root) ?? 0) + 1);
        let released = false;
        return {
            release: () => {
                if (released) return;
                released = true;
                const count = this.#roots.get(root);
                if (count === undefined || count <= 1) this.#roots.delete(root);
                else this.#roots.set(root, count - 1);
            }
        };
    }

    dispose(): void {
        this.#roots.clear();
        this.#hooks.deregister();
    }

    #containsParent(parentUrl: string | undefined): boolean {
        if (parentUrl === undefined || !parentUrl.startsWith("file:")) return false;
        let parentPath: string;
        try {
            parentPath = fileURLToPath(parentUrl);
        } catch {
            return false;
        }
        for (const root of this.#roots.keys()) {
            const candidate = relative(root, parentPath);
            if (candidate === "" || (!candidate.startsWith("..") && !isAbsolute(candidate))) return true;
        }
        return false;
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
