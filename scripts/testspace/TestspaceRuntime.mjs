import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function resolveTestspaceRuntimeDirectory(root) {
    const userIdentity = typeof process.getuid === "function"
        ? String(process.getuid())
        : (process.env.USERNAME ?? process.env.USER ?? "unknown");
    const identity = createHash("sha256")
        .update(`${userIdentity}:${root}`)
        .digest("hex")
        .slice(0, 16);
    return join(tmpdir(), `pds-testspace-${identity}`);
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
    if (process.platform === "win32") return false;
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
