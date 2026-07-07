import type { CliLifecycleManagerLike } from "./CliCommandControlStart.js";

export class CliCommandControlStatus {
    async execute(lifecycle: CliLifecycleManagerLike): Promise<{ instanceCount: number; pid?: number; running: boolean }> {
        return await lifecycle.status();
    }
}
