import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { lstat, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import {
    createTestspaceProcessEnvironment,
    resolveTestspaceRuntimeDirectory,
} from "./TestspaceRuntime.mjs";

export const TESTSPACE_ISOLATION_ENV = "DEVSHELL_TESTSPACE_ISOLATION";
export const TESTSPACE_TOKEN_ENV = "DEVSHELL_TESTSPACE_TOKEN";
export const TESTSPACE_ROOT_ENV = "DEVSHELL_TESTSPACE_ROOT";
export const LINUX_TESTSPACE_ISOLATION = "linux-user-pid-mount-v1";
export const PROCESS_TESTSPACE_ISOLATION = "process-env-v1";

const NAMESPACE_STATE_FILE = "namespace.json";
const NAMESPACE_LOG_FILE = "namespace.log";

export function resolveTestspaceNamespaceDirectory(root, options = {}) {
    const temporaryDirectory = options.temporaryDirectory ?? tmpdir();
    const userIdentity = options.userIdentity ?? (
        typeof process.getuid === "function"
            ? String(process.getuid())
            : (process.env.USERNAME ?? process.env.USER ?? "unknown")
    );
    const identity = createHash("sha256")
        .update(`${userIdentity}:${resolve(root)}`)
        .digest("hex")
        .slice(0, 16);
    return join(temporaryDirectory, `pds-testspace-ns-${userIdentity}-${identity}`);
}

export function buildTestspaceExecutionEnvironment(root, token, options = {}) {
    const resolvedRoot = resolve(root);
    const homeDirectory = join(resolvedRoot, "home");
    const runtimeDirectory = resolveTestspaceRuntimeDirectory(resolvedRoot, options.runtimeOptions);
    return {
        ...createTestspaceProcessEnvironment(
            homeDirectory,
            runtimeDirectory,
            options.baseEnvironment ?? process.env,
        ),
        PORTABLE_DEVSHELL_HOME: join(homeDirectory, ".devshell"),
        [TESTSPACE_ISOLATION_ENV]: options.isolation ?? (
            (options.platform ?? process.platform) === "linux"
                ? LINUX_TESTSPACE_ISOLATION
                : PROCESS_TESTSPACE_ISOLATION
        ),
        [TESTSPACE_ROOT_ENV]: resolvedRoot,
        [TESTSPACE_TOKEN_ENV]: token,
    };
}

export function assertTestspaceExecutionContext(root, environment = process.env, options = {}) {
    const platform = options.platform ?? process.platform;
    const isolation = environment[TESTSPACE_ISOLATION_ENV];
    const token = environment[TESTSPACE_TOKEN_ENV];
    if (typeof token !== "string" || token.length < 32) {
        throw new Error("Testspace lifecycle requires the guarded Testspace launcher.");
    }
    if (environment[TESTSPACE_ROOT_ENV] !== resolve(root)) {
        throw new Error("Testspace lifecycle root does not match the guarded launcher root.");
    }
    const expectedIsolation = platform === "linux"
        ? LINUX_TESTSPACE_ISOLATION
        : PROCESS_TESTSPACE_ISOLATION;
    if (isolation !== expectedIsolation) {
        throw new Error(`Testspace lifecycle requires ${expectedIsolation}.`);
    }
}

export function assertTestspaceLifecycleEnvironment(root, environment, options = {}) {
    assertTestspaceExecutionContext(root, environment, options);
    const resolvedRoot = resolve(root);
    const expected = buildTestspaceExecutionEnvironment(
        root,
        environment[TESTSPACE_TOKEN_ENV],
        {
            baseEnvironment: environment,
            isolation: environment[TESTSPACE_ISOLATION_ENV],
            platform: options.platform ?? process.platform,
            runtimeOptions: options.runtimeOptions,
        },
    );
    for (const name of [
        "HOME",
        "USERPROFILE",
        "XDG_CACHE_HOME",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "PORTABLE_DEVSHELL_HOME",
    ]) {
        if (environment[name] !== expected[name]) {
            throw new Error(`Testspace lifecycle refused non-isolated ${name}.`);
        }
    }
    const runtimeDirectory = environment.XDG_RUNTIME_DIR;
    if (typeof runtimeDirectory !== "string" || runtimeDirectory.length === 0) {
        throw new Error("Testspace lifecycle refused missing XDG_RUNTIME_DIR.");
    }
    const resolvedRuntime = resolve(runtimeDirectory);
    const primaryRuntime = resolveTestspaceRuntimeDirectory(resolvedRoot, options.runtimeOptions);
    if (resolvedRuntime !== primaryRuntime && !pathIsWithin(resolvedRoot, resolvedRuntime)) {
        throw new Error("Testspace lifecycle refused non-isolated XDG_RUNTIME_DIR.");
    }
}

function pathIsWithin(parent, candidate) {
    const child = relative(parent, candidate);
    return child !== "" && child !== ".." && !child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(child);
}

export async function ensureLinuxTestspaceNamespace(root, options = {}) {
    const namespaceDirectory = resolveTestspaceNamespaceDirectory(root, options);
    await ensurePrivateDirectory(namespaceDirectory);
    const statePath = join(namespaceDirectory, NAMESPACE_STATE_FILE);
    const existing = await readNamespaceState(statePath);
    if (existing !== undefined && await validateNamespaceState(existing, root)) {
        return { ...existing, created: false, namespaceDirectory, statePath };
    }
    if (existing !== undefined) await rm(statePath, { force: true });

    const token = randomBytes(24).toString("hex");
    const supervisorPath = options.supervisorPath;
    if (typeof supervisorPath !== "string" || supervisorPath.length === 0) {
        throw new Error("Testspace namespace supervisor path is required.");
    }
    const logPath = join(namespaceDirectory, NAMESPACE_LOG_FILE);
    const logFd = openSync(logPath, "a", 0o600);
    const unshare = spawn(options.unshareCommand ?? "unshare", [
        "--user",
        "--map-root-user",
        "--pid",
        "--fork",
        "--mount-proc",
        "--kill-child=KILL",
        options.supervisorCommand ?? "python3",
        supervisorPath,
    ], {
        cwd: options.cwd,
        detached: true,
        env: {
            ...(options.baseEnvironment ?? process.env),
            [TESTSPACE_ROOT_ENV]: resolve(root),
            [TESTSPACE_TOKEN_ENV]: token,
        },
        stdio: ["ignore", logFd, logFd],
    });
    unshare.unref();
    closeSync(logFd);
    if (!Number.isInteger(unshare.pid) || unshare.pid <= 0) {
        throw new Error("Testspace namespace supervisor did not start.");
    }
    const initHostPid = await waitForNamespaceChild(unshare.pid, options);
    const state = {
        initHostPid,
        root: resolve(root),
        token,
        unsharePid: unshare.pid,
        version: 1,
    };
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
    });
    return { ...state, created: true, namespaceDirectory, statePath };
}

export function runInsideTestspaceNamespace(state, scriptPath, argv, options = {}) {
    const environment = buildTestspaceExecutionEnvironment(state.root, state.token, {
        baseEnvironment: options.baseEnvironment ?? process.env,
        isolation: LINUX_TESTSPACE_ISOLATION,
        platform: "linux",
    });
    const result = spawnSync(options.nsenterCommand ?? "nsenter", [
        "--target",
        String(state.initHostPid),
        "--user",
        "--mount",
        "--pid",
        "--preserve-credentials",
        process.execPath,
        scriptPath,
        ...argv,
    ], {
        cwd: options.cwd,
        env: environment,
        stdio: "inherit",
    });
    if (result.error !== undefined) throw result.error;
    return result.status ?? 1;
}

export async function stopLinuxTestspaceNamespace(state, options = {}) {
    if (!await validateNamespaceState(state, state.root)) return false;
    try {
        process.kill(state.initHostPid, "SIGTERM");
    } catch (error) {
        if (error?.code !== "ESRCH") throw error;
    }
    const deadline = Date.now() + (options.timeoutMs ?? 3_000);
    while (isProcessAlive(state.initHostPid) && Date.now() < deadline) {
        await delay(25);
    }
    if (isProcessAlive(state.initHostPid)) {
        throw new Error(`Testspace namespace PID ${state.initHostPid} did not stop.`);
    }
    await rm(state.statePath, { force: true });
    return true;
}

export function runWithoutLinuxNamespace(root, scriptPath, argv, options = {}) {
    const token = randomBytes(24).toString("hex");
    const environment = buildTestspaceExecutionEnvironment(root, token, {
        baseEnvironment: options.baseEnvironment ?? process.env,
        isolation: PROCESS_TESTSPACE_ISOLATION,
        platform: options.platform ?? process.platform,
    });
    const result = spawnSync(process.execPath, [scriptPath, ...argv], {
        cwd: options.cwd,
        env: environment,
        stdio: "inherit",
    });
    if (result.error !== undefined) throw result.error;
    return result.status ?? 1;
}

async function ensurePrivateDirectory(directory) {
    try {
        const current = await lstat(directory);
        if (!current.isDirectory() || current.isSymbolicLink()) {
            throw new Error(`Testspace namespace path is not a private directory: ${directory}`);
        }
        if (typeof process.getuid === "function" && current.uid !== process.getuid()) {
            throw new Error(`Testspace namespace path is not owned by the current user: ${directory}`);
        }
    } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        await mkdir(directory, { recursive: false, mode: 0o700 });
    }
    const current = await stat(directory);
    if ((current.mode & 0o077) !== 0) {
        throw new Error(`Testspace namespace path permissions are too broad: ${directory}`);
    }
}

async function readNamespaceState(path) {
    try {
        const value = JSON.parse(await readFile(path, "utf8"));
        if (
            value?.version !== 1 ||
            !Number.isInteger(value.unsharePid) ||
            !Number.isInteger(value.initHostPid) ||
            typeof value.root !== "string" ||
            typeof value.token !== "string"
        ) return undefined;
        return value;
    } catch {
        return undefined;
    }
}

async function validateNamespaceState(state, root) {
    if (state.root !== resolve(root)) return false;
    if (state.token.length < 32) return false;
    if (!isProcessAlive(state.unsharePid) || !isProcessAlive(state.initHostPid)) return false;
    try {
        const children = await readChildren(state.unsharePid);
        return children.includes(state.initHostPid);
    } catch {
        return false;
    }
}

async function waitForNamespaceChild(unsharePid, options = {}) {
    const deadline = Date.now() + (options.startTimeoutMs ?? 5_000);
    while (Date.now() < deadline) {
        if (!isProcessAlive(unsharePid)) {
            throw new Error("Testspace namespace supervisor exited before becoming ready.");
        }
        const children = await readChildren(unsharePid).catch(() => []);
        const child = children[0];
        if (Number.isInteger(child) && child > 0 && isProcessAlive(child)) return child;
        await delay(25);
    }
    throw new Error("Timed out waiting for the Testspace namespace supervisor.");
}

async function readChildren(pid) {
    const source = await readFile(`/proc/${pid}/task/${pid}/children`, "utf8");
    return source.trim().split(/\s+/u)
        .filter(Boolean)
        .map((value) => Number.parseInt(value, 10))
        .filter((value) => Number.isInteger(value) && value > 0);
}

function isProcessAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function delay(ms) {
    return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
