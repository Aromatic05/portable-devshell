import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import { posix, resolve } from "node:path";

export const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

export async function ipcEndpointAcceptsConnections(path: string): Promise<boolean> {
    return await new Promise<boolean>((resolvePromise) => {
        const socket = createConnection(path);
        socket.once("connect", () => {
            socket.destroy();
            resolvePromise(true);
        });
        socket.once("error", () => resolvePromise(false));
    });
}

export function createTestIpcPath(
    name: string,
    directory: string,
    platform = process.platform
): string {
    const normalized = name.replaceAll(/[^A-Za-z0-9._-]/gu, "-");
    if (platform === "win32") {
        return `\\\\.\\pipe\\portable-devshell-test-${normalized}-${process.pid}-${randomUUID()}`;
    }
    if (platform === "darwin") {
        const shortName = normalized.slice(0, 16) || "ipc";
        return posix.join(
            "/tmp",
            `pds-${shortName}-${process.pid}-${randomUUID().slice(0, 8)}.sock`
        );
    }
    return posix.join(directory, `${normalized}.sock`);
}

export function resolveTestWorkerBinary(): string | undefined {
    const configured = process.env.PORTABLE_DEVSHELL_TEST_WORKER_PATH;
    const targetDirectory = process.env.CARGO_TARGET_DIR;
    const candidate = configured !== undefined && configured.length > 0
        ? resolve(repositoryRoot, configured)
        : resolve(
            targetDirectory === undefined || targetDirectory.length === 0
                ? resolve(repositoryRoot, "target")
                : resolve(repositoryRoot, targetDirectory),
            "debug",
            `devshell-worker${process.platform === "win32" ? ".exe" : ""}`
        );
    return existsSync(candidate) ? candidate : undefined;
}

export function realWorkerTestOptions(workerBinaryPath: string | undefined): { skip: false | string } {
    return {
        skip: workerBinaryPath === undefined
            ? "requires PORTABLE_DEVSHELL_TEST_WORKER_PATH or a host worker in target/debug"
            : false
    };
}

export function createTestWindowsIdentity(label: string): string {
    return `portable-devshell-${label.replaceAll(/[^A-Za-z0-9._-]/gu, "-")}-${process.pid}-${randomUUID()}`;
}

export function installUniqueWindowsTestIdentity(label: string): () => void {
    if (process.platform !== "win32") {
        return () => undefined;
    }
    const previous = process.env.USERNAME;
    process.env.USERNAME = createTestWindowsIdentity(label);
    return () => {
        if (previous === undefined) {
            delete process.env.USERNAME;
        } else {
            process.env.USERNAME = previous;
        }
    };
}

export function readRelativeMarkerCommand(fileName: string): string {
    if (!/^[A-Za-z0-9._-]+$/u.test(fileName)) {
        throw new Error(`invalid test marker file: ${fileName}`);
    }
    return process.platform === "win32"
        ? `[Console]::Out.Write((Get-Content -Raw -LiteralPath '.\\${fileName}'))`
        : `cat -- './${fileName}'`;
}

export function terminalPrintCommand(marker: string, delayMs = 0): string {
    const [left, right] = splitTerminalMarker(marker);
    if (!Number.isSafeInteger(delayMs) || delayMs < 0) {
        throw new Error(`invalid terminal delay: ${delayMs}`);
    }
    if (process.platform === "win32") {
        const delay = delayMs === 0 ? "" : `Start-Sleep -Milliseconds ${delayMs}; `;
        return `powershell.exe -NoLogo -NoProfile -NonInteractive -Command "${delay}[Console]::WriteLine(('${left}' + '${right}'))"\r`;
    }
    const delay = delayMs === 0 ? "" : `sleep ${(delayMs / 1000).toFixed(3)}; `;
    return `${delay}printf '%s%s\\n' '${left}' '${right}'\r`;
}

export function terminalSizeProbeCommand(): string {
    return process.platform === "win32"
        ? `powershell.exe -NoLogo -NoProfile -NonInteractive -Command "$s=$Host.UI.RawUI.WindowSize; [Console]::WriteLine(('{0} {1}' -f $s.Height,$s.Width))"\r`
        : "stty size\r";
}

export function terminalExpectedSize(rows: number, cols: number): string {
    return `${rows} ${cols}`;
}

function splitTerminalMarker(marker: string): [string, string] {
    if (!/^[A-Za-z0-9._-]{2,128}$/u.test(marker)) {
        throw new Error(`invalid terminal marker: ${marker}`);
    }
    const middle = Math.floor(marker.length / 2);
    return [marker.slice(0, middle), marker.slice(middle)];
}

export function workerPathEnvironmentName(platform = process.platform, arch = process.arch): string {
    return `PORTABLE_DEVSHELL_WORKER_${normalizeWorkerPlatform(platform)}_${normalizeWorkerArch(arch)}_PATH`;
}

export function commandAvailable(command: string, args: readonly string[] = []): boolean {
    const result = spawnSync(command, args, {
        stdio: "ignore",
        windowsHide: true
    });
    return result.status === 0;
}

export function tmuxTestOptions(workerBinaryPath: string | undefined): { skip: false | string } {
    if (workerBinaryPath === undefined) {
        return realWorkerTestOptions(workerBinaryPath);
    }
    if (process.platform === "win32") {
        return { skip: "tmux worker tools are Unix-only" };
    }
    return {
        skip: commandAvailable("tmux", ["-V"])
            ? false
            : "requires tmux on PATH"
    };
}

function normalizeWorkerPlatform(platform: string): string {
    switch (platform) {
        case "linux":
            return "LINUX";
        case "darwin":
            return "DARWIN";
        case "win32":
            return "WINDOWS";
        default:
            throw new Error(`unsupported test worker platform: ${platform}`);
    }
}

function normalizeWorkerArch(arch: string): string {
    switch (arch) {
        case "x64":
            return "X64";
        case "arm64":
            return "ARM64";
        default:
            throw new Error(`unsupported test worker architecture: ${arch}`);
    }
}
