import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

export interface ControlDaemonLaunchOptions {
    daemonModulePath: string;
    env?: NodeJS.ProcessEnv;
    homeDirectory?: string;
    spawnFunction?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
    xdgRuntimeDir?: string;
}

export class ControlDaemonLauncher {
    static spawnDetached(options: ControlDaemonLaunchOptions): ChildProcess {
        const spawnFunction = options.spawnFunction ?? spawn;
        const env: NodeJS.ProcessEnv = { ...process.env, ...options.env };
        if (options.homeDirectory !== undefined) {
            env.HOME = options.homeDirectory;
            if (process.platform === "win32") env.USERPROFILE = options.homeDirectory;
        }
        if (options.xdgRuntimeDir !== undefined) env.XDG_RUNTIME_DIR = options.xdgRuntimeDir;
        const child = spawnFunction(
            process.execPath,
            [...collectNodeBootstrapArgs(process.execArgv), options.daemonModulePath],
            { detached: true, env, stdio: "ignore" }
        );
        child.unref();
        return child;
    }
}

function collectNodeBootstrapArgs(execArgv: readonly string[]): string[] {
    const args: string[] = [];
    for (let index = 0; index < execArgv.length; index += 1) {
        const current = execArgv[index]!;
        if ((current === "--import" || current === "--loader") && execArgv[index + 1] !== undefined) {
            args.push(current, execArgv[index + 1]!);
            index += 1;
            continue;
        }
        if (current.startsWith("--import=") || current.startsWith("--loader=")) args.push(current);
    }
    return args;
}
