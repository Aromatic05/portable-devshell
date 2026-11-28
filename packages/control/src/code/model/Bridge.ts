import type { CodeObjectDescriptor } from "../Api.js";
import { formatMethodSignature } from "../schema/DtsEmitter.js";

export interface CodeBootstrapObjectInfo {
    readonly callable: boolean;
    readonly id: string;
    readonly methods: readonly { readonly name: string; readonly signature: string }[];
    readonly scopeLevel: "control" | "instance";
    readonly summary: string;
}

export interface CodeBootstrapCatalog {
    readonly activeInstance?: string;
    readonly activeWorkspace?: string;
    readonly audience: "model" | "native";
    readonly objects: readonly CodeBootstrapObjectInfo[];
}

export function buildBootstrapCatalog(options: {
    activeInstance?: string;
    activeWorkspace?: string;
    audience: "model" | "native";
    objects: readonly CodeObjectDescriptor[];
}): CodeBootstrapCatalog {
    return {
        ...(options.activeInstance === undefined
            ? {}
            : { activeInstance: options.activeInstance }),
        ...(options.activeWorkspace === undefined
            ? {}
            : { activeWorkspace: options.activeWorkspace }),
        audience: options.audience,
        objects: options.objects.map((object) => ({
            callable: object.callable === true,
            id: object.id,
            methods: object.methods.map((method) => ({
                name: method.name,
                signature: formatMethodSignature(method, `devshell.${object.id}`),
            })),
            scopeLevel: object.scopeLevel,
            summary: object.summary,
        })),
    };
}

/**
 * Generates the frozen QuickJS bootstrap script that exposes `devshell`,
 * `console`, and `sleep`, backed by the injected `__devshell_host__` primitive.
 * The host primitive is immediately deleted from globalThis after capture.
 */
export function buildBootstrapScript(catalog: CodeBootstrapCatalog): string {
    const serializedCatalog = JSON.stringify(catalog);
    return `
(() => {
  const host = globalThis.__devshell_host__;
  delete globalThis.__devshell_host__;
  const catalog = ${serializedCatalog};

  const controlObjects = new Map();
  const instanceObjects = new Map();
  for (const obj of catalog.objects) {
    if (obj.scopeLevel === "instance") instanceObjects.set(obj.id, obj);
    else controlObjects.set(obj.id, obj);
  }

  function formatAvailableMethods(obj) {
    if (!obj || obj.methods.length === 0) return "  (no methods)";
    return obj.methods.map((m) => "  " + m.signature).join("\\n");
  }

  function makeNamespaceProxy(obj, target, callableFn) {
    const methodMap = new Map(obj.methods.map((m) => [m.name, m]));
    const base = callableFn || Object.create(null);
    return new Proxy(base, {
      get(_t, prop) {
        if (prop === Symbol.toStringTag) return "DevShellNamespace(" + obj.id + ")";
        if (prop === "then") return undefined;
        if (typeof prop === "symbol") return undefined;
        if (prop === "help") {
          return (filter) => host.help(obj.id, filter);
        }
        if (methodMap.has(prop)) {
          return (input) => {
            if (obj.scopeLevel === "instance") {
              if (!target || (!target.instance && !target.handle) || !target.workspace) {
                throw new Error(
                  "No active instance/workspace is bound for devshell." + obj.id + "." + prop +
                  "(). Pass --instance and --workspace to \\"devshell code\\", or use devshell.instance({ name, workspace })."
                );
              }
            }
            return host.invoke({
              objectId: obj.id,
              method: prop,
              input: input === undefined ? {} : input,
              instance: target && (target.instance || target.handle),
              workspace: target && target.workspace,
            });
          };
        }
        throw new TypeError(
          "Unknown method: devshell." + obj.id + "." + String(prop) +
          "\\nAvailable on devshell." + obj.id + ":\\n" + formatAvailableMethods(obj)
        );
      },
      ownKeys() {
        return obj.methods.map((m) => m.name);
      },
      getOwnPropertyDescriptor(_t, prop) {
        if (typeof prop === "string" && methodMap.has(prop)) {
          return { configurable: true, enumerable: true };
        }
        return undefined;
      },
    });
  }

  function createInstanceHandle(target) {
    const bound = Object.freeze({
      instance: target.instance,
      handle: target.handle,
      workspace: target.workspace,
    });
    const namespaces = new Map();
    for (const [id, obj] of instanceObjects.entries()) {
      namespaces.set(id, makeNamespaceProxy(obj, bound));
    }
    const availableNames = [...instanceObjects.keys(), "name", "workspace", "withWorkspace", "ready"];
    return new Proxy(Object.create(null), {
      get(_t, prop) {
        if (prop === Symbol.toStringTag) return "DevShellInstanceHandle";
        if (prop === "then") return undefined;
        if (typeof prop === "symbol") return undefined;
        if (prop === "name") return bound.instance || bound.handle || "";
        if (prop === "workspace") return bound.workspace || "";
        if (prop === "withWorkspace") {
          return (nextWorkspace) => {
            if (typeof nextWorkspace !== "string" || nextWorkspace.length === 0) {
              throw new TypeError("withWorkspace(workspace) requires a non-empty path string.");
            }
            return createInstanceHandle({ ...bound, workspace: nextWorkspace });
          };
        }
        if (prop === "ready") {
          return () => host.ready({
            instance: bound.instance || bound.handle,
            workspace: bound.workspace,
          });
        }
        if (namespaces.has(prop)) return namespaces.get(prop);
        throw new TypeError(
          "Unknown property on InstanceHandle: " + String(prop) +
          "\\nAvailable: " + availableNames.join(", ")
        );
      },
      ownKeys() {
        return availableNames;
      },
      getOwnPropertyDescriptor(_t, prop) {
        if (typeof prop === "string" && availableNames.includes(prop)) {
          return { configurable: true, enumerable: true };
        }
        return undefined;
      },
    });
  }

  const rootTarget = {
    instance: catalog.activeInstance,
    workspace: catalog.activeWorkspace,
  };

  const rootNamespaces = new Map();
  for (const [id, obj] of instanceObjects.entries()) {
    rootNamespaces.set(id, makeNamespaceProxy(obj, rootTarget));
  }
  for (const [id, obj] of controlObjects.entries()) {
    if (id === "instance") {
      const instanceFactory = (spec) => {
        if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
          throw new TypeError(
            "devshell.instance(target) requires an object: { name?: string, handle?: string, workspace: string }"
          );
        }
        const name = typeof spec.name === "string" && spec.name.length > 0 ? spec.name : undefined;
        const handle = typeof spec.handle === "string" && spec.handle.length > 0 ? spec.handle : undefined;
        const resolvedName = name || (handle ? undefined : catalog.activeInstance);
        const resolvedWorkspace =
          typeof spec.workspace === "string" && spec.workspace.length > 0
            ? spec.workspace
            : catalog.activeWorkspace;
        if (!resolvedName && !handle) {
          throw new TypeError(
            "devshell.instance(target) requires \\"name\\" (or \\"handle\\" in model mode) when no active instance is bound."
          );
        }
        if (!resolvedWorkspace) {
          throw new TypeError(
            "devshell.instance(target) requires a non-empty \\"workspace\\" path."
          );
        }
        return createInstanceHandle({
          instance: resolvedName,
          handle,
          workspace: resolvedWorkspace,
        });
      };
      rootNamespaces.set(id, makeNamespaceProxy(obj, undefined, instanceFactory));
    } else if (obj.callable) {
      const handleFactory = (target) => {
        const opened = host.openHandle({
          objectId: obj.id,
          target: target === undefined ? {} : target,
          instance: rootTarget.instance,
          workspace: rootTarget.workspace,
        });
        return new Proxy(Object.create(null), {
          get(_t, methodProp) {
            if (methodProp === "then") return undefined;
            if (typeof methodProp === "symbol") return undefined;
            return async (input) => {
              const handleId = await opened;
              return await host.invokeHandle({
                objectId: obj.id,
                handleId,
                method: String(methodProp),
                input: input === undefined ? {} : input,
              });
            };
          },
        });
      };
      rootNamespaces.set(id, makeNamespaceProxy(obj, undefined, handleFactory));
    } else {
      rootNamespaces.set(id, makeNamespaceProxy(obj, undefined));
    }
  }

  const rootKeys = [...rootNamespaces.keys(), "name", "workspace", "withWorkspace", "ready", "help"];
  const devshell = new Proxy(Object.create(null), {
    get(_t, prop) {
      if (prop === Symbol.toStringTag) return "DevShellRoot";
      if (prop === "then") return undefined;
      if (typeof prop === "symbol") return undefined;
      if (prop === "name") return rootTarget.instance || "";
      if (prop === "workspace") return rootTarget.workspace || "";
      if (prop === "withWorkspace") {
        return (nextWorkspace) => {
          if (!rootTarget.instance) {
            throw new Error("No active instance is bound; use devshell.instance({ name, workspace }).");
          }
          return createInstanceHandle({ instance: rootTarget.instance, workspace: nextWorkspace });
        };
      }
      if (prop === "ready") {
        return () => host.ready({ instance: rootTarget.instance, workspace: rootTarget.workspace });
      }
      if (prop === "help") {
        return (target, options) => {
          const filter =
            typeof options === "object" && options !== null && typeof options.filter === "string"
              ? options.filter
              : undefined;
          return host.help(target, filter);
        };
      }
      if (rootNamespaces.has(prop)) return rootNamespaces.get(prop);
      throw new TypeError(
        "Unknown namespace on devshell: " + String(prop) +
        "\\nAvailable: " + [...rootNamespaces.keys()].join(", ") +
        "\\nUse devshell.help() to inspect signatures."
      );
    },
    ownKeys() {
      return rootKeys;
    },
    getOwnPropertyDescriptor(_t, prop) {
      if (typeof prop === "string" && rootKeys.includes(prop)) {
        return { configurable: true, enumerable: true };
      }
      return undefined;
    },
  });

  const makeLogger = (level) => (...args) => host.log(level, args);
  const consoleObj = Object.freeze({
    log: makeLogger("log"),
    info: makeLogger("info"),
    warn: makeLogger("warn"),
    error: makeLogger("error"),
  });

  Object.defineProperty(globalThis, "devshell", {
    value: devshell,
    writable: false,
    enumerable: true,
    configurable: false,
  });
  Object.defineProperty(globalThis, "console", {
    value: consoleObj,
    writable: false,
    enumerable: true,
    configurable: false,
  });
  Object.defineProperty(globalThis, "sleep", {
    value: (ms) => host.sleep(Number(ms)),
    writable: false,
    enumerable: true,
    configurable: false,
  });
})();
`;
}
