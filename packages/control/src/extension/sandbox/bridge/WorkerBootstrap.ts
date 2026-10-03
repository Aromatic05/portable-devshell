import type { ResourceLimits } from "node:worker_threads";

export const DEFAULT_EXTENSION_SANDBOX_RESOURCE_LIMITS: Readonly<ResourceLimits> =
    Object.freeze({
        maxOldGenerationSizeMb: 128,
        maxYoungGenerationSizeMb: 32,
        stackSizeMb: 4,
    });

export const DEFAULT_EXTENSION_SANDBOX_EXTERNAL_MEMORY_LIMIT_MB = 128;

export function sandboxWorkerModuleUrl(): URL {
    return new URL(
        import.meta.url.endsWith(".ts") ? "../Worker.ts" : "../Worker.js",
        import.meta.url,
    );
}

export function extensionSandboxExecArgv(): string[] {
    return [
        ...(import.meta.url.endsWith(".ts")
            ? sourceSandboxExecArgv()
            : sandboxInheritedExecArgv(process.execArgv)),
        "--permission",
        "--allow-fs-read=*",
        "--allow-fs-write=*",
        "--disable-warning=SecurityWarning",
    ];
}

function sourceSandboxExecArgv(): string[] {
    return [
        "--enable-source-maps",
        "--disable-warning=ExperimentalWarning",
        `--import=${new URL("../SourceLoader.mjs", import.meta.url).href}`,
    ];
}

function sandboxInheritedExecArgv(arguments_: readonly string[]): string[] {
    const inherited: string[] = [];
    for (let index = 0; index < arguments_.length; index += 1) {
        const argument = arguments_[index]!;
        if (
            argument === "--enable-source-maps" ||
            argument.startsWith("--import=") ||
            argument.startsWith("--loader=") ||
            argument.startsWith("--experimental-loader=") ||
            argument.startsWith("--require=")
        ) {
            inherited.push(argument);
            continue;
        }
        if (
            [
                "--import",
                "--loader",
                "--experimental-loader",
                "--require",
                "-r",
            ].includes(argument)
        ) {
            const value = arguments_[++index];
            if (value !== undefined) inherited.push(argument, value);
        }
    }
    return inherited;
}
