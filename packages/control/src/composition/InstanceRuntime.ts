import {
    InstancePaths,
    createInstanceApprovalService,
    createInstanceTaskServices,
    createInstanceTerminalBackend,
    type ApprovalApi,
    type InstanceDescriptor,
    type InstanceRegistry,
    type TaskApi,
    type TerminalBackend,
} from "@portable-devshell/core";
import { asInstanceName, type ControlConfig } from "@portable-devshell/shared";
import type { ApprovalPolicy } from "@portable-devshell/shared/config";

export interface InstanceDomainServices {
    readonly approval: ApprovalApi;
    readonly task: TaskApi;
    readonly terminal?: TerminalBackend;
}

export interface InstanceDomainRuntimePort {
    approval(instance: string): ApprovalApi | undefined;
    services(descriptor: InstanceDescriptor): InstanceDomainServices;
    task(instance: string): TaskApi | undefined;
}

interface InstanceRuntimeEntry {
    approval?: ApprovalApi;
    approvalFacade: ApprovalApi;
    readonly name: string;
    readonly paths: InstancePaths;
    policy?: ApprovalPolicy;
    task?: TaskApi;
    taskFacade: TaskApi;
    worker: InstanceDescriptor["worker"];
}

export class InstanceDomainRuntime implements InstanceDomainRuntimePort {
    readonly #entries = new Map<string, InstanceRuntimeEntry>();
    readonly #terminals = new WeakMap<
        InstanceDescriptor["worker"],
        TerminalBackend
    >();
    readonly #getConfig: () => ControlConfig;
    readonly #homeDirectory?: string;
    readonly #instances: InstanceRegistry;

    constructor(options: {
        getConfig: () => ControlConfig;
        homeDirectory?: string;
        instances: InstanceRegistry;
    }) {
        this.#getConfig = options.getConfig;
        this.#homeDirectory = options.homeDirectory;
        this.#instances = options.instances;
    }

    services(descriptor: InstanceDescriptor): InstanceDomainServices {
        const entry = this.#entry(descriptor);
        let terminal = this.#terminals.get(descriptor.worker);
        if (terminal === undefined) {
            terminal = createInstanceTerminalBackend(descriptor.worker);
            this.#terminals.set(descriptor.worker, terminal);
        }
        return {
            approval: entry.approvalFacade,
            task: entry.taskFacade,
            terminal,
        };
    }

    approval(instance: string): ApprovalApi | undefined {
        const descriptor = this.#instances.get(instance);
        return descriptor === undefined
            ? this.#entries.get(instance)?.approvalFacade
            : this.#entry(descriptor).approvalFacade;
    }

    task(instance: string): TaskApi | undefined {
        const descriptor = this.#instances.get(instance);
        return descriptor === undefined
            ? this.#entries.get(instance)?.taskFacade
            : this.#entry(descriptor).taskFacade;
    }

    requireTask(instance: string): TaskApi {
        const task = this.task(instance);
        if (task !== undefined) return task;
        throw new Error(`Instance ${instance} task runtime is unavailable.`);
    }

    async retireDisabled(instance: string): Promise<void> {
        const entry = this.#entries.get(instance);
        if (entry === undefined) return;
        const approval = this.#approval(entry);
        const failures: unknown[] = [];
        entry.task?.wait.close();
        await approval
            .retire(`Instance ${instance} was disabled before approval.`)
            .catch((error) => failures.push(error));
        if (failures.length > 0)
            throw new AggregateError(
                failures,
                `Instance ${instance} interaction retirement was incomplete.`,
            );
    }

    async retireDeleted(instance: string): Promise<void> {
        const entry = this.#entries.get(instance);
        if (entry === undefined) return;
        const approval = this.#approval(entry);
        const task = this.#task(entry);
        const failures: unknown[] = [];
        task.wait.close();
        await approval
            .retire(`Instance ${instance} was deleted.`)
            .catch((error) => failures.push(error));
        await task.goal.stopAll().catch((error) => failures.push(error));
        await task.todo.cancelAll().catch((error) => failures.push(error));
        if (failures.length > 0)
            throw new AggregateError(
                failures,
                `Instance ${instance} domain retirement was incomplete.`,
            );
    }

    close(instance: string): void {
        const entry = this.#entries.get(instance);
        if (entry === undefined) return;
        entry.approval?.close();
        entry.task?.wait.close();
        this.#entries.delete(instance);
    }

    closeAll(): void {
        for (const instance of [...this.#entries.keys()]) this.close(instance);
    }

    #entry(descriptor: InstanceDescriptor): InstanceRuntimeEntry {
        const configured = this.#getConfig().instances.find(
            (instance) => instance.name === descriptor.name,
        );
        const existing = this.#entries.get(descriptor.name);
        if (existing !== undefined) {
            existing.worker = descriptor.worker;
            existing.policy = configured?.approvalPolicy;
            existing.approval?.setPolicy(existing.policy);
            return existing;
        }
        const paths = new InstancePaths(
            asInstanceName(descriptor.name),
            this.#homeDirectory,
        );
        const entry = {
            name: descriptor.name,
            paths,
            policy: configured?.approvalPolicy,
            worker: descriptor.worker,
        } as InstanceRuntimeEntry;
        entry.approvalFacade = lazyMethods(
            () => this.#approval(entry),
            {
                close: () => entry.approval?.close(),
                setPolicy: (policy: ApprovalPolicy | undefined) => {
                    entry.policy = policy;
                    entry.approval?.setPolicy(policy);
                },
            },
        );
        entry.taskFacade = {
            goal: lazyMethods(() => this.#task(entry).goal),
            todo: lazyMethods(() => this.#task(entry).todo),
            wait: lazyMethods(() => this.#task(entry).wait),
        };
        this.#entries.set(descriptor.name, entry);
        return entry;
    }

    #approval(entry: InstanceRuntimeEntry): ApprovalApi {
        if (entry.approval !== undefined) return entry.approval;
        entry.approval = createInstanceApprovalService({
            appendEvent: async (type, data) =>
                await entry.worker.appendControlEvent(type, data),
            instanceName: asInstanceName(entry.name),
            paths: entry.paths,
            policy: entry.policy,
        });
        return entry.approval;
    }

    #task(entry: InstanceRuntimeEntry): TaskApi {
        if (entry.task !== undefined) return entry.task;
        entry.task = createInstanceTaskServices({
            appendEvent: async (type, data) => {
                await entry.worker.appendControlEvent(type, data);
            },
            instanceName: asInstanceName(entry.name),
            invokeTool: async (toolName, input, context, signal) =>
                await entry.worker.invokeToolInternal(
                    toolName,
                    input,
                    context,
                    signal,
                ),
            paths: entry.paths,
        });
        return entry.task;
    }
}

function lazyMethods<T extends object>(
    load: () => T,
    overrides: Partial<T> = {},
): T {
    return new Proxy(overrides as T, {
        get(target, property) {
            if (Reflect.has(target, property)) return Reflect.get(target, property);
            return (...args: unknown[]) => {
                const loaded = load();
                const method = Reflect.get(loaded, property);
                if (typeof method !== "function") return method;
                return Reflect.apply(method, loaded, args);
            };
        },
    });
}
