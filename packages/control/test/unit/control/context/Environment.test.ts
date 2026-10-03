import assert from "node:assert/strict";
import test from "node:test";

import type { McpContextRecord } from "@portable-devshell/shared";
import type { ContextRegistryPort } from "@portable-devshell/shared";
import type {
    McpEndpointWorkerPort,
    McpInstanceGateway,
} from "@portable-devshell/mcp";
import { ContextCleanupService } from "../../../../src/context/Service/Cleanup.js";
import { ContextEnvironmentService } from "../../../../src/context/Service/Scope.js";
import { ContextRegistry } from "../../../../src/context/Registry/index.js";

function worker() {
    return {
        async prepareWorkspace(workspace: string) {
            return {
                projectMemoryAgentFile: `${workspace}/AGENTS.md`,
                projectMemoryDirectory: `${workspace}/.agent`,
                temporaryDirectory: `${workspace}/tmp`,
                workspace,
            };
        },
        async touchTemporaryDirectory() {},
        async releaseAlerts() {},
    } as unknown as McpEndpointWorkerPort;
}

function runtime(
    registry: ContextRegistry,
    gateway: McpInstanceGateway,
    localWorker = worker(),
) {
    const cleanup = new ContextCleanupService({
        contextRegistry: registry,
        gateway: () => gateway,
        releaseLocalAlerts: async () => {},
    });
    const environment = new ContextEnvironmentService({
        contextRegistry: registry,
        cleanup,
        gateway: () => gateway,
        worker: (instance) => (instance === "local" ? localWorker : undefined),
    });
    return { cleanup, environment };
}

function gateway(overrides: Partial<McpInstanceGateway> = {}) {
    return {
        assertReady() {},
        async connectInstance() {
            return {};
        },
        async releaseInstanceReference() {},
        async prepareWorkspace(_instance: string, workspace: string) {
            return {
                projectMemoryAgentFile: `${workspace}/AGENTS.md`,
                projectMemoryDirectory: `${workspace}/.agent`,
                temporaryDirectory: `${workspace}/tmp`,
                workspace,
            };
        },
        async readAlerts() {
            return { advice: [] };
        },
        async touchTemporaryDirectory() {},
        async releaseAlerts() {},
        async readGoal() {
            return { goalId: "goal-1", status: "active" as const };
        },
        async manageGoal() {
            return undefined;
        },
        async goalContinuation() {
            return {};
        },
        async listWaits() {
            return [];
        },
        ...overrides,
    } as unknown as McpInstanceGateway;
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((complete) => {
        resolve = complete;
    });
    return { promise, resolve };
}

async function createContext(
    registry: ContextRegistry,
    instance: string,
    workspace: string,
): Promise<McpContextRecord> {
    return await registry.create({
        principal: "user-1",
        environments: [
            { instance, workspace, temporaryDirectory: `${workspace}/tmp` },
        ],
    });
}

test("local and remote workspace switches both stop at active Goal guard", async () => {
    const registry = new ContextRegistry({ idFactory: () => "ctx-goal" });
    await createContext(registry, "local", "/old");
    const reference = await registry.referenceInstance("ctx-goal", "remote");
    await registry.attachEnvironment("ctx-goal", {
        instance: "remote",
        workspace: "/remote-old",
    });
    const { environment } = runtime(registry, gateway());
    await assert.rejects(
        environment.prepareLocal("ctx-goal", "local", "/new"),
        /Workspace Goal goal-1 is still active/,
    );
    assert.ok(reference?.handle);
    await assert.rejects(
        environment.attachRemote("ctx-goal", reference.handle, "/remote-new"),
        /Workspace Goal goal-1 is still active/,
    );
});

test("local and remote workspace switches both stop at unfinished Wait guard", async () => {
    const registry = new ContextRegistry({ idFactory: () => "ctx-wait" });
    await createContext(registry, "local", "/old");
    const reference = await registry.referenceInstance("ctx-wait", "remote");
    await registry.attachEnvironment("ctx-wait", {
        instance: "remote",
        workspace: "/remote-old",
    });
    const waitGateway = gateway({
        async readGoal() {
            return undefined;
        },
        async listWaits(instance: string) {
            return [
                {
                    waitId: "wait-1",
                    status: "waiting",
                    createdByCtxId: "ctx-wait",
                    workspace: instance === "local" ? "/old" : "/remote-old",
                    automaticRecovery: true,
                },
            ] as never;
        },
    });
    const { environment } = runtime(registry, waitGateway);
    await assert.rejects(
        environment.prepareLocal("ctx-wait", "local", "/new"),
        /Workspace wait wait-1 is still attached/,
    );
    await assert.rejects(
        environment.attachRemote("ctx-wait", reference!.handle!, "/remote-new"),
        /Workspace wait wait-1 is still attached/,
    );
});

test("canonical workspace aliases pass the same-scope guard locally and remotely", async () => {
    const registry = new ContextRegistry({ idFactory: () => "ctx-canonical" });
    await createContext(registry, "local", "/canonical");
    const reference = await registry.referenceInstance(
        "ctx-canonical",
        "remote",
    );
    await registry.attachEnvironment("ctx-canonical", {
        instance: "remote",
        workspace: "/canonical",
    });
    const localWorker = {
        ...worker(),
        async prepareWorkspace() {
            return {
                projectMemoryAgentFile: "",
                projectMemoryDirectory: "",
                temporaryDirectory: "/canonical/tmp",
                workspace: "/canonical",
            };
        },
    } as unknown as McpEndpointWorkerPort;
    const remote = gateway({
        async prepareWorkspace() {
            return {
                projectMemoryAgentFile: "",
                projectMemoryDirectory: "",
                temporaryDirectory: "/canonical/tmp",
                workspace: "/canonical",
            };
        },
    });
    const cleanup = new ContextCleanupService({
        contextRegistry: registry,
        gateway: () => remote,
    });
    const environment = new ContextEnvironmentService({
        contextRegistry: registry,
        cleanup,
        gateway: () => remote,
        worker: (instance) => (instance === "local" ? localWorker : undefined),
    });
    await environment.prepareLocal("ctx-canonical", "local", "/alias");
    await environment.attachRemote(
        "ctx-canonical",
        reference!.handle!,
        "/alias",
    );
    assert.deepEqual(
        (
            await registry.lookup("ctx-canonical", { principal: "user-1" })
        ).environments.map(({ workspace }) => workspace),
        ["/canonical", "/canonical"],
    );
});

test("temporary storage is restored only for its stored workspace", async () => {
    const registry = new ContextRegistry({ idFactory: () => "ctx-temp" });
    await createContext(registry, "local", "/same");
    let prepared = 0;
    const touched: string[] = [];
    const localWorker = {
        ...worker(),
        async prepareWorkspace(workspace: string) {
            prepared += 1;
            return {
                projectMemoryAgentFile: "",
                projectMemoryDirectory: "",
                temporaryDirectory: `${workspace}/new-tmp`,
                workspace,
            };
        },
        async touchTemporaryDirectory(path: string) {
            touched.push(path);
        },
    } as unknown as McpEndpointWorkerPort;
    const { environment } = runtime(registry, gateway(), localWorker);
    const restored = await environment.ensurePrepared(
        "ctx-temp",
        "local",
        "/same",
    );
    assert.equal(restored.temporaryDirectory, "/same/tmp");
    assert.deepEqual(touched, ["/same/tmp"]);
    assert.equal(prepared, 0);
    await assert.rejects(
        environment.ensurePrepared("ctx-temp", "local", "/other"),
        /Workspace Goal|switch workspace through environ_info first/,
    );
    assert.equal(
        (await registry.resolveEnvironment("ctx-temp", "local"))?.workspace,
        "/same",
    );
});

test("shared workspace alert cleanup waits until the final active Context releases it", async () => {
    const registry = new ContextRegistry({ idFactory: () => "ctx-a" });
    const first = await createContext(registry, "remote", "/shared");
    const second = await registry.create({
        principal: "user-2",
        environments: [{ instance: "remote", workspace: "/shared" }],
    });
    let releases = 0;
    const remote = gateway({
        async releaseAlerts() {
            releases += 1;
        },
    });
    const cleanup = new ContextCleanupService({
        contextRegistry: registry,
        gateway: () => remote,
    });
    await registry.recordEnvironmentCleanup(first.ctxId, {
        instance: "remote",
        kind: "alerts",
        workspace: "/shared",
    });
    await registry.recordEnvironmentCleanup(second.ctxId, {
        instance: "remote",
        kind: "alerts",
        workspace: "/shared",
    });
    await registry.detachEnvironment(first.ctxId, "remote");
    await cleanup.reconcile(first.ctxId);
    assert.equal(releases, 0);
    await registry.detachEnvironment(second.ctxId, "remote");
    await cleanup.reconcile(first.ctxId);
    assert.equal(releases, 1);
});

test("successful remote attach settles its own committed alert cleanup intent", async () => {
    const registry = new ContextRegistry({
        idFactory: () => "ctx-remote-commit",
    });
    await registry.create({ principal: "user-1" });
    const reference = await registry.referenceInstance(
        "ctx-remote-commit",
        "remote",
    );
    const remote = gateway();
    const { environment } = runtime(registry, remote);
    await environment.attachRemote(
        "ctx-remote-commit",
        reference!.handle!,
        "/projects/gamma",
    );
    assert.deepEqual(
        await registry.listEnvironmentCleanup("ctx-remote-commit"),
        [],
    );
    assert.deepEqual(
        await registry.resolveEnvironment("ctx-remote-commit", "remote"),
        {
            instance: "remote",
            temporaryDirectory: "/projects/gamma/tmp",
            workspace: "/projects/gamma",
        },
    );
});

test("cancelled remote attach records and settles its reference cleanup debt", async () => {
    const registry = new ContextRegistry({ idFactory: () => "ctx-cancel" });
    await registry.create({ principal: "user-1" });
    await registry.referenceInstance("ctx-cancel", "remote");
    const controller = new AbortController();
    const remote = gateway({
        async connectInstance() {
            controller.abort(new Error("cancelled"));
            return {};
        },
        async releaseInstanceReference() {
            throw new Error("release unavailable");
        },
    });
    const { environment } = runtime(registry, remote);
    const reference = await registry.referenceInstance("ctx-cancel", "remote");
    await assert.rejects(
        environment.attachRemote(
            "ctx-cancel",
            reference!.handle!,
            undefined,
            controller.signal,
        ),
        /cancelled/,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(
        (await registry.listEnvironmentCleanup("ctx-cancel")).map(
            ({ cleanup }) => cleanup.kind,
        ),
        ["instance_reference"],
    );
});

test("cancellation after remote preparation retains alert cleanup debt", async () => {
    const registry = new ContextRegistry({
        idFactory: () => "ctx-remote-prepare-cancel",
    });
    await registry.create({ principal: "user-1" });
    const reference = await registry.referenceInstance(
        "ctx-remote-prepare-cancel",
        "remote",
    );
    const controller = new AbortController();
    let observeRelease!: () => void;
    const releaseAttempted = new Promise<void>((resolve) => {
        observeRelease = resolve;
    });
    const remote = gateway({
        async prepareWorkspace(_instance: string, workspace: string) {
            controller.abort(new Error("cancel during workspace preparation"));
            return {
                projectMemoryAgentFile: "",
                projectMemoryDirectory: "",
                temporaryDirectory: `${workspace}/tmp`,
                workspace,
            };
        },
        async releaseAlerts() {
            observeRelease();
            throw new Error("alert release unavailable");
        },
    });
    const { environment } = runtime(registry, remote);
    await assert.rejects(
        environment.attachRemote(
            "ctx-remote-prepare-cancel",
            reference!.handle!,
            "/work/new",
            controller.signal,
        ),
        /cancel during workspace preparation/,
    );
    await releaseAttempted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(
        (
            await registry.listEnvironmentCleanup("ctx-remote-prepare-cancel")
        ).map(({ cleanup }) => cleanup.kind),
        ["alerts"],
    );
    assert.deepEqual(
        (
            await registry.lookup("ctx-remote-prepare-cancel", {
                principal: "user-1",
            })
        ).environments,
        [],
    );
});

test("local cancellation after preparation releases alerts without changing the prior binding", async () => {
    const registry = new ContextRegistry({
        idFactory: () => "ctx-local-before",
    });
    await createContext(registry, "local", "/old");
    const controller = new AbortController();
    let releases = 0;
    const localGateway = gateway({
        async readGoal() {
            return undefined;
        },
        async releaseAlerts() {
            releases += 1;
        },
    });
    const cleanup = new ContextCleanupService({
        contextRegistry: registry,
        gateway: () => localGateway,
    });
    const localWorker = {
        ...worker(),
        async prepareWorkspace(workspace: string) {
            controller.abort(new Error("cancel before attach"));
            return {
                projectMemoryAgentFile: "",
                projectMemoryDirectory: "",
                temporaryDirectory: `${workspace}/tmp`,
                workspace,
            };
        },
    } as unknown as McpEndpointWorkerPort;
    const environment = new ContextEnvironmentService({
        contextRegistry: registry,
        cleanup,
        gateway: () => localGateway,
        worker: (instance) => (instance === "local" ? localWorker : undefined),
    });
    await assert.rejects(
        environment.prepareLocal("ctx-local-before", "local", "/new", {
            signal: controller.signal,
        }),
        /cancel before attach/,
    );
    assert.deepEqual(
        await registry.resolveEnvironment("ctx-local-before", "local"),
        {
            instance: "local",
            temporaryDirectory: "/old/tmp",
            workspace: "/old",
        },
    );
    assert.equal(releases, 1);
    assert.deepEqual(
        await registry.listEnvironmentCleanup("ctx-local-before"),
        [],
    );
});

test("local cancellation after attach restores the prior workspace and temporary directory", async () => {
    const registry = new ContextRegistry({
        idFactory: () => "ctx-local-after",
    });
    await createContext(registry, "local", "/old");
    const controller = new AbortController();
    const localGateway = gateway({
        async readGoal() {
            return undefined;
        },
    });
    const cleanup = new ContextCleanupService({
        contextRegistry: registry,
        gateway: () => localGateway,
    });
    const transactionalRegistry = new Proxy(registry, {
        get(target, property) {
            if (property === "attachEnvironment") {
                return async (
                    ...args: Parameters<
                        ContextRegistryPort["attachEnvironment"]
                    >
                ) => {
                    const record = await target.attachEnvironment(...args);
                    controller.abort(new Error("cancel after attach"));
                    return record;
                };
            }
            const value = Reflect.get(target, property, target) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
        },
    }) as unknown as ContextRegistryPort;
    const localWorker = worker();
    const environment = new ContextEnvironmentService({
        contextRegistry: transactionalRegistry,
        cleanup,
        gateway: () => localGateway,
        worker: (instance) => (instance === "local" ? localWorker : undefined),
    });
    await assert.rejects(
        environment.prepareLocal("ctx-local-after", "local", "/new", {
            signal: controller.signal,
        }),
        /cancel after attach/,
    );
    assert.deepEqual(
        await registry.resolveEnvironment("ctx-local-after", "local"),
        {
            instance: "local",
            temporaryDirectory: "/old/tmp",
            workspace: "/old",
        },
    );
});

test("bootstrap rollback preserves alert debt when preparation and alert release fail", async () => {
    const registry = new ContextRegistry({
        idFactory: () => "ctx-bootstrap-debt",
    });
    await registry.create({
        principal: "user-1",
        environments: [{ instance: "local" }],
    });
    const cleanup = new ContextCleanupService({
        contextRegistry: registry,
        gateway: () => undefined,
    });
    const environment = new ContextEnvironmentService({
        contextRegistry: registry,
        cleanup,
        gateway: () => undefined,
        worker: (instance) => (instance === "local" ? worker() : undefined),
    });
    await assert.rejects(
        environment.prepareLocal(
            "ctx-bootstrap-debt",
            "local",
            "/work/bootstrap",
            {
                beforeCommit: async () => {
                    throw new Error("readAlerts failed");
                },
            },
        ),
    );
    await assert.rejects(
        environment.rollbackUndisclosed("ctx-bootstrap-debt", "local"),
    );
    const retained = await registry.lookup("ctx-bootstrap-debt", {
        principal: "user-1",
    });
    assert.equal(retained.status, "disabled");
    assert.deepEqual(
        (await registry.listEnvironmentCleanup("ctx-bootstrap-debt")).map(
            ({ cleanup: debt }) => debt.kind,
        ),
        ["alerts"],
    );
});

test("local deferred preparation cannot reattach the last Context after instance retirement", async () => {
    const registry = new ContextRegistry({
        idFactory: () => "ctx-retired-local",
    });
    await createContext(registry, "local", "/work/old");
    const prepared =
        deferred<
            Awaited<
                ReturnType<
                    NonNullable<McpEndpointWorkerPort["prepareWorkspace"]>
                >
            >
        >();
    let prepareStarted!: () => void;
    const started = new Promise<void>((resolve) => {
        prepareStarted = resolve;
    });
    const retiredWorker = {
        ...worker(),
        async prepareWorkspace() {
            prepareStarted();
            return await prepared.promise;
        },
    } as unknown as McpEndpointWorkerPort;
    let currentWorker: McpEndpointWorkerPort | undefined = retiredWorker;
    const localGateway = gateway({
        async readGoal() {
            return undefined;
        },
    });
    const cleanup = new ContextCleanupService({
        contextRegistry: registry,
        gateway: () => localGateway,
    });
    const environment = new ContextEnvironmentService({
        contextRegistry: registry,
        cleanup,
        gateway: () => localGateway,
        worker: () => currentWorker,
    });
    const preparing = environment.prepareLocal(
        "ctx-retired-local",
        "local",
        "/work/new",
    );
    await started;
    await registry.detachInstance("local");
    currentWorker = undefined;
    prepared.resolve({
        projectMemoryAgentFile: "/work/new/AGENTS.md",
        projectMemoryDirectory: "/work/new/.agent",
        temporaryDirectory: "/work/new/tmp",
        workspace: "/work/new",
    });
    await assert.rejects(preparing, /retired or replaced/);
    const record = await registry.lookup("ctx-retired-local", {
        principal: "user-1",
    });
    assert.deepEqual(record.environments, []);
});

test("remote attach checks target readiness after deferred preparation before attaching", async () => {
    const registry = new ContextRegistry({
        idFactory: () => "ctx-retired-remote",
    });
    await registry.create({ principal: "user-1" });
    const reference = await registry.referenceInstance(
        "ctx-retired-remote",
        "remote",
    );
    const prepared =
        deferred<Awaited<ReturnType<McpInstanceGateway["prepareWorkspace"]>>>();
    let prepareStarted!: () => void;
    const started = new Promise<void>((resolve) => {
        prepareStarted = resolve;
    });
    let retired = false;
    let readinessChecks = 0;
    const remote = gateway({
        async prepareWorkspace() {
            prepareStarted();
            return await prepared.promise;
        },
        assertReady() {
            readinessChecks += 1;
            if (retired) throw new Error("remote instance retired");
        },
    });
    const { environment } = runtime(registry, remote);
    const attaching = environment.attachRemote(
        "ctx-retired-remote",
        reference!.handle!,
        "/work/remote",
    );
    await started;
    retired = true;
    prepared.resolve({
        projectMemoryAgentFile: "/work/remote/AGENTS.md",
        projectMemoryDirectory: "/work/remote/.agent",
        temporaryDirectory: "/work/remote/tmp",
        workspace: "/work/remote",
    });
    await assert.rejects(attaching, /remote instance retired/);
    assert.equal(readinessChecks, 1);
    assert.deepEqual(
        (await registry.lookup("ctx-retired-remote", { principal: "user-1" }))
            .environments,
        [],
    );
});

test("ensurePrepared checks remote readiness before persisting prepared state", async () => {
    const registry = new ContextRegistry({
        idFactory: () => "ctx-retired-ensure",
    });
    await registry.create({
        principal: "user-1",
        environments: [{ instance: "remote", workspace: "/work/remote" }],
    });
    const prepared =
        deferred<Awaited<ReturnType<McpInstanceGateway["prepareWorkspace"]>>>();
    let prepareStarted!: () => void;
    const started = new Promise<void>((resolve) => {
        prepareStarted = resolve;
    });
    let retired = false;
    const remote = gateway({
        async prepareWorkspace() {
            prepareStarted();
            return await prepared.promise;
        },
        assertReady() {
            if (retired) throw new Error("remote instance retired");
        },
    });
    const { environment } = runtime(registry, remote);
    const ensuring = environment.ensurePrepared("ctx-retired-ensure", "remote");
    await started;
    retired = true;
    prepared.resolve({
        projectMemoryAgentFile: "/work/remote/AGENTS.md",
        projectMemoryDirectory: "/work/remote/.agent",
        temporaryDirectory: "/work/remote/tmp",
        workspace: "/work/remote",
    });
    await assert.rejects(ensuring, /remote instance retired/);
    assert.deepEqual(
        await registry.resolveEnvironment("ctx-retired-ensure", "remote"),
        { instance: "remote", workspace: "/work/remote" },
    );
});
