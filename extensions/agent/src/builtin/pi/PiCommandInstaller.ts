import {
    chmod,
    lstat,
    mkdir,
    readFile,
    readlink,
    rename,
    rm,
    writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { ExtensionContext } from "@portable-devshell/extension";

const OWNED_MARKER = "portable-devshell-agent:pi-launcher-v1";

export interface PiCommandInstallResult {
    command: string;
    installed: boolean;
    reason?: "collision" | "launcher-missing";
}

export interface PiCommandInstallOptions {
    environment?: NodeJS.ProcessEnv;
    homeDirectory?: string;
    platform?: NodeJS.Platform;
}

export async function ensureBundledPiCommand(
    context: ExtensionContext,
    options: PiCommandInstallOptions = {},
): Promise<PiCommandInstallResult> {
    const environment = options.environment ?? process.env;
    const homeDirectory = options.homeDirectory ?? homedir();
    const platform = options.platform ?? process.platform;
    const launcher = join(
        context.paths.codeDirectory,
        "dist",
        "builtin",
        "pi",
        "PiLauncher.js",
    );
    const launcherMetadata = await lstat(launcher).catch((error: unknown) => {
        if (isMissing(error)) return undefined;
        throw error;
    });
    const binDirectory =
        environment.PORTABLE_DEVSHELL_BIN_DIR ??
        resolve(homeDirectory, ".local", "bin");
    const command = join(binDirectory, platform === "win32" ? "pi.cmd" : "pi");
    if (
        launcherMetadata === undefined ||
        launcherMetadata.isSymbolicLink() ||
        !launcherMetadata.isFile()
    ) {
        return { command, installed: false, reason: "launcher-missing" };
    }

    const existing = await inspectExistingCommand(command);
    if (existing === "foreign")
        return { command, installed: false, reason: "collision" };

    await mkdir(binDirectory, { recursive: true });
    const launcherUrl = pathToFileURL(launcher).href;
    const wrapperSource = [
        "#!/usr/bin/env node",
        `// ${OWNED_MARKER}`,
        `const { launchInstalledPi } = await import(${JSON.stringify(launcherUrl)});`,
        "try {",
        "    await launchInstalledPi();",
        "} catch (error) {",
        "    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\\n`);",
        "    process.exitCode = 1;",
        "}",
        "",
    ].join("\n");
    if (platform === "win32") {
        const wrapper = join(binDirectory, ".portable-devshell-agent-pi.mjs");
        await replaceFile(wrapper, wrapperSource, 0o600);
        await replaceFile(
            command,
            `@echo off\r\nREM ${OWNED_MARKER}\r\nnode "%~dp0\\.portable-devshell-agent-pi.mjs" %*\r\n`,
            0o600,
        );
    } else {
        await replaceFile(command, wrapperSource, 0o755);
    }
    return { command, installed: true };
}

async function replaceFile(
    path: string,
    source: string,
    mode: number,
): Promise<void> {
    const temporary = `${path}.${process.pid}.tmp`;
    try {
        await writeFile(temporary, source, { mode });
        await chmod(temporary, mode);
        await rm(path, { force: true });
        await rename(temporary, path);
    } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
    }
}

async function inspectExistingCommand(
    path: string,
): Promise<"absent" | "foreign" | "owned"> {
    const metadata = await lstat(path).catch((error: unknown) => {
        if (isMissing(error)) return undefined;
        throw error;
    });
    if (metadata === undefined) return "absent";
    if (metadata.isSymbolicLink()) {
        const target = await readlink(path);
        return isLegacyCorePiLauncher(target) ? "owned" : "foreign";
    }
    if (!metadata.isFile()) return "foreign";
    const source = await readFile(path, "utf8").catch(() => "");
    if (source.includes(OWNED_MARKER)) return "owned";
    if (
        source.includes("portable-devshell-pi-launcher.mjs") &&
        source.includes("portable-devshell")
    )
        return "owned";
    return "foreign";
}

function isLegacyCorePiLauncher(target: string): boolean {
    return (
        basename(target) === "portable-devshell-pi-launcher.mjs" &&
        target.includes("portable-devshell")
    );
}

function isMissing(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
    );
}
