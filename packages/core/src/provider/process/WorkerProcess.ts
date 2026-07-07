import type { ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";

export interface WorkerRpcExitResult {
    code: number | null;
    signal: NodeJS.Signals | null;
}

export interface WorkerRpcProcess {
    readonly stdin: Writable | null;
    readonly stdout: Readable | null;
    readonly stderr: Readable | null;
    kill(signal?: NodeJS.Signals | number): boolean;
    readonly exit: Promise<WorkerRpcExitResult>;
}

export function createWorkerRpcProcess(child: ChildProcess): WorkerRpcProcess {
    return {
        stdin: child.stdin,
        stdout: child.stdout,
        stderr: child.stderr,
        kill(signal) {
            return child.kill(signal);
        },
        exit: new Promise<WorkerRpcExitResult>((resolve, reject) => {
            child.once("error", reject);
            child.once("exit", (code, signal) => {
                resolve({ code, signal });
            });
        })
    };
}
