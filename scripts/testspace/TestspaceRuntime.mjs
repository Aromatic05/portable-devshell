import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { extname, join, posix, win32 } from "node:path";

const require = createRequire(new URL("../../packages/control/package.json", import.meta.url));
const toml = require("smol-toml");

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

export function stopTestspaceTmux(runtimeDirectory, instanceName) {
    if (process.platform === "win32") return false;
    const socketPath = join(
        runtimeDirectory,
        "devshell-worker",
        instanceName,
        "tmux.sock",
    );
    if (!existsSync(socketPath)) return false;

    const probe = spawnSync("tmux", ["-S", socketPath, "list-sessions"], {
        encoding: "utf8",
    });
    if (probe.status !== 0) return false;

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
    return true;
}
