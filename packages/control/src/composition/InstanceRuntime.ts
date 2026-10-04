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

export interface InstanceDomainServices {
    readonly approval: ApprovalApi;
    readonly task: TaskApi;
    readonly terminal: TerminalBackend;
}

interface InstanceRuntimeEntry {
    readonly approval: ApprovalApi;
    readonly task: TaskApi;
    worker: InstanceDescriptor["worker"];
}

export class InstanceDomainRuntime {
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
        const entry = this.#ensure(descriptor);
        let terminal = this.#terminals.get(descriptor.worker);
        if (terminal === undefined) {
            terminal = createInstanceTerminalBackend(descriptor.worker);
            this.#terminals.set(descriptor.worker, terminal);
        }
        return { approval: entry.approval, task: entry.task, terminal };
    }

    approval(instance: string): ApprovalApi | undefined {
        const descriptor = this.#instances.get(instance);
        return descriptor === undefined
            ? this.#entries.get(instance)?.approval
            : this.#ensure(descriptor).approval;
    }

    task(instance: string): TaskApi | undefined {
        const descriptor = this.#instances.get(instance);
        return descriptor === undefined
            ? this.#entries.get(instance)?.task
            : this.#ensure(descriptor).task;
    }

    requireTask(instance: string): TaskApi {
        const task = this.task(instance);
        if (task !== undefined) return task;
        throw new Error(`Instance ${instance} task runtime is unavailable.`);
    }

    async retireDisabled(instance: string): Promise<void> {
        const entry = this.#entries.get(instance);
        if (entry === undefined) return;
        const failures: unknown[] = [];
        await entry.approval
            .retire(`Instance ${instance} was disabled before approval.`)
            .catch((error) => failures.push(error));
        if (entry.task.wait !== undefined) {
            try {
                for (const wait of await entry.task.wait.list()) {
                    if (wait.status !== "waiting" && wait.status !== "detached")
                        continue;
                    await entry.task.wait
                        .cancel(wait.waitId)
                        .catch((error) => failures.push(error));
                }
            } catch (error) {
                failures.push(error);
            }
        }
        if (failures.length > 0)
            throw new AggregateError(
                failures,
                `Instance ${instance} interaction retirement was incomplete.`,
            );
    }

    async retireDeleted(instance: string): Promise<void> {
        const entry = this.#entries.get(instance);
        if (entry === undefined) return;
        const failures: unknown[] = [];
        await entry.approval
            .retire(`Instance ${instance} was deleted.`)
            .catch((error) => failures.push(error));
        if (entry.task.wait !== undefined) {
            try {
                for (const wait of await entry.task.wait.list()) {
                    if (
                        wait.status !== "waiting" &&
                        wait.status !== "detached" &&
                        wait.status !== "resolved"
                    )
                        continue;
                    try {
                        if (wait.status === "resolved")
                            await entry.task.wait.consume(wait.waitId);
                        else await entry.task.wait.cancel(wait.waitId);
                    } catch (error) {
                        failures.push(error);
                    }
                }
            } catch (error) {
                failures.push(error);
            }
        }
        await entry.task.goal.stopAll().catch((error) => failures.push(error));
        await entry.task.todo.cancelAll().catch((error) => failures.push(error));
        if (failures.length > 0)
            throw new AggregateError(
                failures,
                `Instance ${instance} domain retirement was incomplete.`,
            );
    }

    close(instance: string): void {
        const entry = this.#entries.get(instance);
        if (entry === undefined) return;
        entry.approval.close();
        this.#entries.delete(instance);
    }

    closeAll(): void {
        for (const instance of [...this.#entries.keys()]) this.close(instance);
    }

    #ensure(descriptor: InstanceDescriptor): InstanceRuntimeEntry {
        const configured = this.#getConfig().instances.find(
            (instance) => instance.name === descriptor.name,
        );
        const existing = this.#entries.get(descriptor.name);
        if (existing !== undefined) {
            existing.worker = descriptor.worker;
            existing.approval.setPolicy(configured?.approvalPolicy);
            return existing;
        }
        const paths = new InstancePaths(
            asInstanceName(descriptor.name),
            this.#homeDirectory,
        );
        const entry = {} as InstanceRuntimeEntry;
        entry.worker = descriptor.worker;
        const appendEvent = async (type: string, data: unknown): Promise<void> => {
            await entry.worker.appendControlEvent(type, data as never);
        };
        Object.assign(entry, {
            approval: createInstanceApprovalService({
                appendEvent: appendEvent as never,
                instanceName: asInstanceName(descriptor.name),
                paths,
                policy: configured?.approvalPolicy,
            }),
            task: createInstanceTaskServices({
                appendEvent: appendEvent as never,
                instanceName: asInstanceName(descriptor.name),
                paths,
            }),
        });
        this.#entries.set(descriptor.name, entry);
        return entry;
    }
}
