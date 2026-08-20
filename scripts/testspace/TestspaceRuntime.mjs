import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join, parse, posix, relative, resolve, sep, win32 } from "node:path";

const require = createRequire(new URL("../../packages/control/package.json", import.meta.url));
const toml = require("smol-toml");
const { blake3 } = require("hash-wasm");
const TESTSPACE_OWNER_FILE = ".portable-devshell-testspace-owner.json";
const TESTSPACE_OWNER_KIND = "portable-devshell-testspace";

export function resolveTestspaceRoot(repositoryRoot, configuredRoot) {
    if (configuredRoot !== undefined && configuredRoot.trim().length === 0) {
        throw new Error("DEVSHELL_TESTSPACE_ROOT must not be empty.");
    }
    const root = resolve(configuredRoot ?? join(repositoryRoot, ".testspace"));
    const repository = resolve(repositoryRoot);
    const repositoryFromRoot = relative(root, repository);
    const rootContainsRepository =
        repositoryFromRoot === "" ||
        (
            repositoryFromRoot !== ".." &&
            !repositoryFromRoot.startsWith(`..${sep}`) &&
            !isAbsolute(repositoryFromRoot)
        );
    if (rootContainsRepository) {
        throw new Error("DEVSHELL_TESTSPACE_ROOT must not contain the portable-devshell repository.");
    }
    if (root === parse(root).root) {
        throw new Error("DEVSHELL_TESTSPACE_ROOT must not be a filesystem root.");
    }
    return root;
}

export async function markTestspaceRootOwned(repositoryRoot, root) {
    const resolvedRoot = resolve(root);
    await mkdir(resolvedRoot, { recursive: true });
    await writeFile(
        join(resolvedRoot, TESTSPACE_OWNER_FILE),
        `${JSON.stringify({
            kind: TESTSPACE_OWNER_KIND,
            repositoryRoot: resolve(repositoryRoot),
            root: resolvedRoot,
            version: 1,
        }, null, 2)}\n`,
        "utf8",
    );
}

export async function assertTestspaceRootOwned(repositoryRoot, root) {
    const resolvedRepository = resolve(repositoryRoot);
    const resolvedRoot = resolve(root);
    if (!existsSync(resolvedRoot)) return false;

    const legacyDefaultRoot = resolve(resolvedRepository, ".testspace");
    if (resolvedRoot !== legacyDefaultRoot) {
        const marker = await readTestspaceOwner(resolvedRoot);
        if (
            marker?.kind !== TESTSPACE_OWNER_KIND ||
            marker?.repositoryRoot !== resolvedRepository ||
            marker?.root !== resolvedRoot
        ) {
            throw new Error(
                `Refusing recursive cleanup because ${resolvedRoot} is not owned by portable-devshell Testspace.`,
            );
        }
    }

    return true;
}

export async function removeOwnedTestspaceRoot(repositoryRoot, root) {
    const resolvedRoot = resolve(root);
    if (!await assertTestspaceRootOwned(repositoryRoot, resolvedRoot)) return false;

    await rm(resolvedRoot, { force: true, recursive: true });
    return true;
}

async function readTestspaceOwner(root) {
    try {
        return JSON.parse(await readFile(join(root, TESTSPACE_OWNER_FILE), "utf8"));
    } catch {
        return undefined;
    }
}

export function resolveTestspaceRuntimeDirectory(root, options = {}) {
    const platform = options.platform ?? process.platform;
    const temporaryDirectory = options.temporaryDirectory ?? tmpdir();
    const runtimeRoot = platform === "win32" ? temporaryDirectory : "/tmp";
    const joinPath = platform === "win32" ? win32.join : posix.join;
    const userIdentity = typeof process.getuid === "function"
        ? String(process.getuid())
        : (process.env.USERNAME ?? process.env.USER ?? "unknown");
    const identity = createHash("sha256")
        .update(`${userIdentity}:${root}`)
        .digest("hex")
        .slice(0, 16);
    return joinPath(runtimeRoot, `pds-testspace-${identity}`);
}

export function createTestspaceProcessEnvironment(homeDirectory, runtimeDirectory, baseEnvironment = process.env) {
    const dataHome = join(homeDirectory, ".local", "share");
    return {
        ...baseEnvironment,
        HOME: homeDirectory,
        LOCALAPPDATA: runtimeDirectory,
        USERPROFILE: homeDirectory,
        XDG_CACHE_HOME: join(homeDirectory, ".cache"),
        XDG_CONFIG_HOME: join(homeDirectory, ".config"),
        XDG_DATA_HOME: dataHome,
        XDG_RUNTIME_DIR: runtimeDirectory,
    };
}

export function resetTestspacePodmanStorage(
    homeDirectory,
    runtimeDirectory,
    options = {},
) {
    const platform = options.platform ?? process.platform;
    if (platform === "win32") return false;
    const exists = options.exists ?? existsSync;
    const ensureRuntime = options.ensureRuntime ?? ((directory) =>
        mkdirSync(directory, { mode: 0o700, recursive: true })
    );
    const spawn = options.spawn ?? spawnSync;
    const storageDirectory = join(
        homeDirectory,
        ".local",
        "share",
        "containers",
        "storage",
    );
    if (!exists(storageDirectory)) return false;

    ensureRuntime(runtimeDirectory);
    const result = spawn("podman", ["system", "reset", "--force"], {
        encoding: "utf8",
        env: createTestspaceProcessEnvironment(
            homeDirectory,
            runtimeDirectory,
        ),
    });
    if (result.status !== 0) {
        throw new Error(
            result.stderr ||
            result.error?.message ||
            `failed to reset testspace Podman storage at ${storageDirectory}`,
        );
    }
    return true;
}

export function removeTestspaceDockerContainers(
    instanceConfigDirectory,
    options = {},
) {
    const exists = options.exists ?? existsSync;
    const list = options.list ?? readdirSync;
    const read = options.read ?? ((path) => readFileSync(path, "utf8"));
    const spawn = options.spawn ?? spawnSync;
    if (!exists(instanceConfigDirectory)) return [];

    const containerNames = list(instanceConfigDirectory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && extname(entry.name) === ".toml")
        .flatMap((entry) => {
            const config = toml.parse(read(join(instanceConfigDirectory, entry.name)));
            if (
                config.provider !== "docker" ||
                typeof config.name !== "string" ||
                typeof config.container !== "object" ||
                config.container === null ||
                !["preset", "dockerfile", "existingImage"].includes(config.container.mode)
            ) {
                return [];
            }
            return [
                typeof config.container.containerName === "string"
                    ? config.container.containerName
                    : `devshell-${config.name}`,
            ];
        });

    for (const containerName of [...new Set(containerNames)].sort()) {
        const result = spawn("docker", ["rm", "--force", containerName], {
            encoding: "utf8",
        });
        if (
            result.status !== 0 &&
            !`${result.stderr ?? ""}${result.stdout ?? ""}`
                .toLowerCase()
                .includes("no such container")
        ) {
            throw new Error(
                result.stderr ||
                result.error?.message ||
                `failed to remove testspace Docker container ${containerName}`,
            );
        }
    }
    return [...new Set(containerNames)].sort();
}

export async function resolveTestspaceTmuxSockets({
    devshellHome,
    instanceName,
    runtimeDirectory,
    workspace,
}) {
    const defaultRuntimeDirectory = join(runtimeDirectory, "devshell-worker", instanceName);
    const workerSocket = join(defaultRuntimeDirectory, "worker.sock");
    const instanceRuntimeDirectory = Buffer.byteLength(workerSocket) <= 100
        ? defaultRuntimeDirectory
        : join(
            tmpdir(),
            `devshell-worker-${(await blake3(`${devshellHome}:${instanceName}`)).slice(0, 16)}`,
        );
    const workspaceKey = (await blake3(`${join(devshellHome, instanceName)}\0${workspace}`)).slice(0, 16);
    const workspaceCandidate = join(instanceRuntimeDirectory, `tmux-${workspaceKey}.sock`);
    const workspaceSocket = Buffer.byteLength(workspaceCandidate) <= 100
        ? workspaceCandidate
        : join(tmpdir(), `devshell-tmux-${workspaceKey}.sock`);
    return [...new Set([
        join(instanceRuntimeDirectory, "tmux.sock"),
        workspaceSocket,
    ])];
}

export async function stopTestspaceTmux(options) {
    if (process.platform === "win32") return false;
    let stopped = false;
    for (const socketPath of await resolveTestspaceTmuxSockets(options)) {
        if (!existsSync(socketPath)) continue;
        const probe = spawnSync("tmux", ["-S", socketPath, "list-sessions"], {
            encoding: "utf8",
        });
        if (probe.status !== 0) continue;
        const result = spawnSync("tmux", ["-S", socketPath, "kill-server"], {
            encoding: "utf8",
        });
        if (result.status !== 0) {
            throw new Error(
                result.stderr ||
                result.error?.message ||
                `failed to stop testspace tmux server at ${socketPath}`,
            );
        }
        stopped = true;
    }
    return stopped;
}
