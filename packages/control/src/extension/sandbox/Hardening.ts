import { syncBuiltinESMExports } from "node:module";

const signalProcess = process.kill.bind(process);
const getBuiltinModule = process.getBuiltinModule?.bind(process);

export function hardenSandboxRuntime(): void {
    hardenProcessSignals();
    hardenSharedMemory();
}

function hardenProcessSignals(): void {
    const sandboxKill = (
        pid: number,
        signal?: NodeJS.Signals | number,
    ): true => {
        if (signal !== 0 && (pid === process.pid || pid <= 0)) {
            throw new Error(
                "Extension sandbox cannot signal the Control process or its process group.",
            );
        }
        return signal === undefined
            ? signalProcess(pid)
            : signalProcess(pid, signal);
    };
    Object.defineProperty(process, "kill", {
        configurable: false,
        enumerable: true,
        value: sandboxKill,
        writable: false,
    });
    syncBuiltinESMExports();
}

function hardenSharedMemory(): void {
    Object.defineProperty(globalThis, "SharedArrayBuffer", {
        configurable: false,
        enumerable: false,
        value: undefined,
        writable: false,
    });
    const memory = WebAssembly.Memory;
    const guardedMemory: typeof WebAssembly.Memory = new Proxy(memory, {
        construct(target, argumentsList, newTarget): WebAssembly.Memory {
            const descriptor = argumentsList[0] as
                WebAssembly.MemoryDescriptor | undefined;
            if (descriptor?.shared === true) {
                throw new Error(
                    "Extension sandbox does not allow shared WebAssembly memory.",
                );
            }
            return Reflect.construct(
                target,
                argumentsList,
                newTarget === guardedMemory ? target : newTarget,
            ) as WebAssembly.Memory;
        },
    });
    Object.defineProperty(WebAssembly, "Memory", {
        configurable: false,
        enumerable: true,
        value: guardedMemory,
        writable: false,
    });
    if (getBuiltinModule !== undefined) {
        Object.defineProperty(process, "getBuiltinModule", {
            configurable: false,
            enumerable: true,
            value: (id: string) => {
                if (id === "vm" || id === "node:vm") {
                    throw new Error(
                        `Extension sandbox does not allow builtin module ${id}.`,
                    );
                }
                return getBuiltinModule(id);
            },
            writable: false,
        });
        syncBuiltinESMExports();
    }
}
