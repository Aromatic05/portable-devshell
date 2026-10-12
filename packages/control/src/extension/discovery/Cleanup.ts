import { rm, rmdir } from "node:fs/promises";

import type { ExtensionModule } from "@portable-devshell/extension";

import type {
    ExtensionDatabaseRuntime,
    ExtensionProcessRuntime,
    ExtensionWorkerRuntime,
} from "../api/cap/index.js";
import type { ExtensionConfigRuntime } from "../api/cap/config/index.js";
import type { ExtensionSandboxHost } from "../sandbox/bridge/index.js";
import { isDirectoryNotEmpty, isMissing } from "./Paths.js";

export async function throwInProcessActivationFailure(
    error: unknown,
    input: {
        config?: ExtensionConfigRuntime;
        database: ExtensionDatabaseRuntime;
        extensionId: string;
        module?: ExtensionModule;
        processes: ExtensionProcessRuntime;
        releaseHostModules: () => void;
        runtimeDirectory: string;
        runtimeRoot: string;
        workerDelegate: ExtensionWorkerRuntime;
        workerExecute: ExtensionWorkerRuntime;
    },
): Promise<never> {
    const cleanupFailures: unknown[] = [];
    await Promise.resolve(input.module?.deactivate?.()).catch(
        (cleanupError: unknown) => cleanupFailures.push(cleanupError),
    );
    try {
        input.database.closeAll();
    } catch (cleanupError) {
        cleanupFailures.push(cleanupError);
    }
    await input.processes
        .closeAll()
        .catch((cleanupError) => cleanupFailures.push(cleanupError));
    try {
        input.config?.close();
    } catch (cleanupError) {
        cleanupFailures.push(cleanupError);
    }
    await input.workerDelegate
        .closeAll()
        .catch((cleanupError) => cleanupFailures.push(cleanupError));
    await input.workerExecute
        .closeAll()
        .catch((cleanupError) => cleanupFailures.push(cleanupError));
    await cleanupRuntimeDirectory(
        input.runtimeRoot,
        input.runtimeDirectory,
    ).catch((cleanupError) => cleanupFailures.push(cleanupError));
    try {
        input.releaseHostModules();
    } catch (cleanupError) {
        cleanupFailures.push(cleanupError);
    }
    if (cleanupFailures.length === 0) throw error;
    throw new AggregateError(
        [error, ...cleanupFailures],
        `Extension ${input.extensionId} activation failed and candidate cleanup was incomplete.`,
    );
}

export async function disposeInProcessGeneration(input: {
    config?: ExtensionConfigRuntime;
    database: ExtensionDatabaseRuntime;
    module: ExtensionModule;
    processes: ExtensionProcessRuntime;
    releaseHostModules: () => void;
    runtimeDirectory: string;
    runtimeRoot: string;
    workerDelegate: ExtensionWorkerRuntime;
    workerExecute: ExtensionWorkerRuntime;
}): Promise<void> {
    const failures: unknown[] = [];
    await Promise.resolve(input.module.deactivate?.()).catch((error) =>
        failures.push(error),
    );
    try {
        input.database.closeAll();
    } catch (error) {
        failures.push(error);
    }
    try {
        input.config?.close();
    } catch (error) {
        failures.push(error);
    }
    await input.processes.closeAll().catch((error) => failures.push(error));
    await input.workerDelegate
        .closeAll()
        .catch((error) => failures.push(error));
    await input.workerExecute.closeAll().catch((error) => failures.push(error));
    await cleanupRuntimeDirectory(
        input.runtimeRoot,
        input.runtimeDirectory,
    ).catch((error) => failures.push(error));
    try {
        input.releaseHostModules();
    } catch (error) {
        failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
        throw new AggregateError(
            failures,
            "Extension generation cleanup failed.",
        );
}

export async function throwSandboxActivationFailure(
    error: unknown,
    input: {
        config?: ExtensionConfigRuntime;
        database: ExtensionDatabaseRuntime;
        extensionId: string;
        processes: ExtensionProcessRuntime;
        runtimeDirectory: string;
        runtimeRoot: string;
        sandbox: ExtensionSandboxHost;
        workerDelegate: ExtensionWorkerRuntime;
        workerExecute: ExtensionWorkerRuntime;
    },
): Promise<never> {
    const cleanupFailures: unknown[] = [];
    await input.sandbox
        .dispose()
        .catch((cleanupError) => cleanupFailures.push(cleanupError));
    try {
        input.database.closeAll();
    } catch (cleanupError) {
        cleanupFailures.push(cleanupError);
    }
    await input.processes
        .closeAll()
        .catch((cleanupError) => cleanupFailures.push(cleanupError));
    try {
        input.config?.close();
    } catch (cleanupError) {
        cleanupFailures.push(cleanupError);
    }
    await input.workerDelegate
        .closeAll()
        .catch((cleanupError) => cleanupFailures.push(cleanupError));
    await input.workerExecute
        .closeAll()
        .catch((cleanupError) => cleanupFailures.push(cleanupError));
    await cleanupRuntimeDirectory(
        input.runtimeRoot,
        input.runtimeDirectory,
    ).catch((cleanupError) => cleanupFailures.push(cleanupError));
    if (cleanupFailures.length === 0) throw error;
    throw new AggregateError(
        [error, ...cleanupFailures],
        `Extension ${input.extensionId} sandbox activation failed and candidate cleanup was incomplete.`,
    );
}

export async function disposeSandboxGeneration(input: {
    config?: ExtensionConfigRuntime;
    database: ExtensionDatabaseRuntime;
    processes: ExtensionProcessRuntime;
    runtimeDirectory: string;
    runtimeRoot: string;
    sandbox: ExtensionSandboxHost;
    workerDelegate: ExtensionWorkerRuntime;
    workerExecute: ExtensionWorkerRuntime;
}): Promise<void> {
    const failures: unknown[] = [];
    await input.sandbox.dispose().catch((error) => failures.push(error));
    try {
        input.database.closeAll();
    } catch (error) {
        failures.push(error);
    }
    try {
        input.config?.close();
    } catch (error) {
        failures.push(error);
    }
    await input.processes.closeAll().catch((error) => failures.push(error));
    await input.workerDelegate
        .closeAll()
        .catch((error) => failures.push(error));
    await input.workerExecute.closeAll().catch((error) => failures.push(error));
    await cleanupRuntimeDirectory(
        input.runtimeRoot,
        input.runtimeDirectory,
    ).catch((error) => failures.push(error));
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
        throw new AggregateError(
            failures,
            "Extension sandbox generation cleanup failed.",
        );
}

async function cleanupRuntimeDirectory(
    runtimeRoot: string,
    runtimeDirectory: string,
): Promise<void> {
    await rm(runtimeDirectory, { force: true, recursive: true });
    await rmdir(runtimeRoot).catch((error: unknown) => {
        if (isMissing(error) || isDirectoryNotEmpty(error)) return;
        throw error;
    });
}
