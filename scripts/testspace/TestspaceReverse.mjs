import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";

import { TESTSPACE_REVERSE_INSTANCE } from "./TestspaceConfig.mjs";
import { sanitizeWorkerEnvironment } from "./TestspaceRuntime.mjs";

export { TESTSPACE_REVERSE_INSTANCE };

export async function startTestspaceReverse(options) {
    const {
        controllerUrl,
        environment,
        instanceName = TESTSPACE_REVERSE_INSTANCE,
        paths,
        runtimeDirectory,
        workerPath,
    } = options;
    const createDeviceCode = options.createDeviceCode ?? defaultCreateDeviceCode;
    const runWorker = options.runWorker ?? defaultRunWorker;
    const waitReady = options.waitReady ?? defaultWaitReady;

    await Promise.all([
        mkdir(paths.reverseHome, { recursive: true }),
        mkdir(paths.reverseRuntime, { recursive: true }),
        mkdir(paths.reverseWorkspace, { recursive: true }),
    ]);
    const workerEnvironment = reverseWorkerEnvironment(environment, paths);
    const code = await createDeviceCode({ instanceName, runtimeDirectory });
    const enrollment = runWorker({
        args: [
            "enroll",
            "--controller",
            controllerUrl,
            "--device-code",
            code.deviceCode,
        ],
        environment: workerEnvironment,
        workerPath,
    });
    if (enrollment.status !== 0) {
        throw new Error(
            enrollment.stderr ||
                enrollment.stdout ||
                enrollment.error?.message ||
                `reverse worker enrollment failed for ${instanceName}`,
        );
    }
    await waitReady({ instanceName, runtimeDirectory });
    return {
        controllerUrl,
        instanceName,
        workerHome: paths.reverseDevshellHome,
        workerOutput: enrollment.stdout?.trim() ?? "",
    };
}

export function stopTestspaceReverse(options) {
    const {
        environment,
        instanceName = TESTSPACE_REVERSE_INSTANCE,
        paths,
        workerPath,
    } = options;
    const runWorker = options.runWorker ?? defaultRunWorker;
    const result = runWorker({
        args: ["stop", "--instance", instanceName],
        environment: reverseWorkerEnvironment(environment, paths),
        workerPath,
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.toLowerCase();
    if (
        result.status !== 0 &&
        !output.includes("not running") &&
        !output.includes("not found") &&
        !output.includes("does not exist") &&
        !output.includes("no such file or directory")
    ) {
        throw new Error(
            result.stderr ||
                result.stdout ||
                result.error?.message ||
                `failed to stop reverse worker ${instanceName}`,
        );
    }
    return result.status === 0;
}

export async function readTestspaceReverseStatus(options) {
    const {
        instanceName = TESTSPACE_REVERSE_INSTANCE,
        runtimeDirectory,
    } = options;
    const readSnapshot = options.readSnapshot ?? defaultReadSnapshot;
    try {
        const snapshot = await readSnapshot({ instanceName, runtimeDirectory });
        return {
            connected: snapshot.ready === true && snapshot.reverse?.transport !== undefined,
            generation: snapshot.reverse?.generation,
            ready: snapshot.ready === true,
            transport: snapshot.reverse?.transport,
        };
    } catch {
        return { connected: false, ready: false };
    }
}

export function reverseWorkerEnvironment(environment, paths) {
    return {
        ...sanitizeWorkerEnvironment(environment),
        HOME: paths.reverseHome,
        PORTABLE_DEVSHELL_HOME: paths.reverseDevshellHome,
        XDG_RUNTIME_DIR: paths.reverseRuntime,
    };
}

function defaultRunWorker({ args, environment, workerPath }) {
    return spawnSync(workerPath, args, {
        encoding: "utf8",
        env: environment,
    });
}

async function defaultCreateDeviceCode({ instanceName, runtimeDirectory }) {
    return await withTestspaceControlConnection(runtimeDirectory, async (shared, connection) => {
        const reverse = shared.controlClientModule(connection, "reverse");
        return await reverse.request("createCode", { instance: instanceName });
    });
}

async function defaultReadSnapshot({ instanceName, runtimeDirectory }) {
    return await withTestspaceControlConnection(runtimeDirectory, async (_shared, connection) => {
        const response = await connection.request(instanceName, "runtime", "snapshot");
        return response.snapshot;
    });
}

async function defaultWaitReady({ instanceName, runtimeDirectory }) {
    const deadline = Date.now() + 15_000;
    let lastSnapshot;
    while (Date.now() < deadline) {
        try {
            lastSnapshot = await defaultReadSnapshot({ instanceName, runtimeDirectory });
            if (lastSnapshot.ready === true && lastSnapshot.reverse?.transport === "wss") {
                return;
            }
        } catch {
            // Enrollment and reverse WSS activation may still be converging.
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(
        `reverse worker ${instanceName} did not become ready: ${JSON.stringify(lastSnapshot)}`,
    );
}

export async function withTestspaceControlConnection(runtimeDirectory, operation) {
    const shared = await import("../../packages/shared/dist/index.js");
    const connection = new shared.ClientConnection({
        connectChannel: (signal) =>
            shared.SocketChannel.connect(
                shared.resolveControlSocketPath(runtimeDirectory),
                { signal },
            ),
        mapError: (error) => error instanceof Error ? error : new Error(String(error)),
        mapRemoteError: (error) => shared.createError(error),
        mode: "persistent",
        peer: "cli",
    });
    try {
        const protocolVersion = shared.CONTROL_PROTOCOL_VERSION;
        await connection.request("@control", "service", "hello", {
            clientKind: "cli",
            maxProtocolVersion: protocolVersion,
            minProtocolVersion: protocolVersion,
        });
        return await operation(shared, connection);
    } finally {
        connection.close();
    }
}
