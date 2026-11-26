import { posix, win32 } from "node:path";
import type { Instance } from "@portable-devshell/core";
import type {
    ExtensionWorkerProcess,
    ExtensionWorkerProcessCapability,
    ExtensionWorkerProcessStartInput,
    ExtensionWorkerResourcePath,
} from "@portable-devshell/extension/worker";
import type { MessageStream } from "@portable-devshell/shared";
import type { InstanceRegistry } from "../../../../instance/Api.js";

interface ProcessLease {
    instance: string;
    controller: AbortController;
    done: Promise<void>;
}

/** Worker resource execution is separately granted; no raw Worker RPC is exposed. */
export class ExtensionWorkerProcessControl implements ExtensionWorkerProcessCapability {
    readonly #active = new Set<ProcessLease>();
    #closed = false;
    constructor(private readonly options: {
        allowed: boolean;
        extensionId: string;
        instances: InstanceRegistry;
    }) {}

    async start(input: ExtensionWorkerProcessStartInput, signal?: AbortSignal): Promise<ExtensionWorkerProcess> {
        if (!this.options.allowed || this.#closed) throw new Error("Worker process capability is unavailable.");
        signal?.throwIfAborted();
        const instance = this.options.instances.get(input.instance);
        if (!instance?.lifecycle.active || !instance.supervision.snapshot().ready)
            throw new Error("Worker Instance is unavailable: " + input.instance);
        const lease = instance.lifecycle.acquireLease();
        const controller = new AbortController();
        let resolveDone!: () => void;
        const entry: ProcessLease = {
            instance: input.instance,
            controller,
            done: new Promise<void>((resolve) => { resolveDone = resolve; }),
        };
        this.#active.add(entry);
        const abort = () => controller.abort(signal?.reason);
        signal?.addEventListener("abort", abort, { once: true });
        const offRetirement = instance.lifecycle.onRetiring(() => controller.abort(new Error("Worker Instance retired.")));
        let settled = false;
        const release = () => {
            if (settled) return;
            settled = true;
            offRetirement();
            signal?.removeEventListener("abort", abort);
            this.#active.delete(entry);
            lease.release();
            resolveDone();
        };
        try {
            const executable = await this.#resource(instance, input.executable);
            const args = await Promise.all((input.args ?? []).map((arg) =>
                typeof arg === "string" ? arg : this.#resource(instance, arg)));
            const cwd = input.cwd === undefined ? undefined : await this.#resource(instance, input.cwd);
            controller.signal.throwIfAborted();
            const stream = await instance.openWorkerProcess({ executable, args, cwd, owned: true }, controller.signal);
            stream.onClose(release);
            stream.onCancel(release);
            if (controller.signal.aborted) {
                await stream.cancel({ message: String(controller.signal.reason) });
                throw controller.signal.reason;
            }
            signal?.removeEventListener("abort", abort);
            return processHandle(stream, release);
        } catch (error) {
            release();
            throw error;
        }
    }

    async retireInstance(instance: string): Promise<void> {
        await this.#stop([...this.#active].filter((entry) => entry.instance === instance));
    }

    async closeAll(): Promise<void> {
        this.#closed = true;
        await this.#stop([...this.#active]);
    }

    async #stop(entries: ProcessLease[]): Promise<void> {
        for (const entry of entries) entry.controller.abort(new Error("Extension Worker process retired."));
        await Promise.all(entries.map((entry) => entry.done));
    }

    async #resource(instance: Instance, resource: ExtensionWorkerResourcePath): Promise<string> {
        if (!/^[a-z][a-z0-9-]*$/.test(resource.collection))
            throw new TypeError("Invalid Worker resource collection.");
        const segments = [...(resource.key === undefined ? [] : [resource.key]),
            ...(resource.path === undefined ? [] : resource.path.split("/"))];
        if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes("\\") || segment.includes("/") || segment.includes(":") || segment.includes("\0")))
            throw new TypeError("Worker resource path must be relative to its collection.");
        const root = await instance.environment.prepareExtensionResource({
            extensionId: this.options.extensionId, collection: resource.collection,
        });
        const platform = instance.supervision.handshake?.platform.os;
        return (platform === "windows" || platform === "win32" ? win32 : posix).join(root.directory, ...segments);
    }
}

function processHandle(stream: MessageStream, release: () => void): ExtensionWorkerProcess {
    return {
        read: () => stream.read(),
        write: (bytes) => stream.write(bytes),
        finish: () => stream.finish(),
        close: async () => {
            try { await stream.cancel({ message: "Extension Worker process closed." }); }
            finally { release(); }
        },
    };
}
