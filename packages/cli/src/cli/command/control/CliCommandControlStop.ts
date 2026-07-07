import type { CliLifecycleManagerLike } from "./CliCommandControlStart.js";

export class CliCommandControlStop {
    async execute(lifecycle: CliLifecycleManagerLike): Promise<{ instanceCount: number; pid?: number; running: boolean }> {
        return await lifecycle.stop();
    }
}
