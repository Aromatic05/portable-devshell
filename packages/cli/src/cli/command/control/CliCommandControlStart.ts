export interface CliLifecycleManagerLike {
    logs(): Promise<string>;
    start(): Promise<{ instanceCount: number; pid?: number; running: boolean }>;
    status(): Promise<{ instanceCount: number; pid?: number; running: boolean }>;
    stop(): Promise<{ instanceCount: number; pid?: number; running: boolean }>;
}

export class CliCommandControlStart {
    async execute(lifecycle: CliLifecycleManagerLike): Promise<{ instanceCount: number; pid?: number; running: boolean }> {
        return await lifecycle.start();
    }
}
