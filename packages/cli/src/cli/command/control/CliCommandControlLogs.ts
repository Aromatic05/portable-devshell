import type { CliLifecycleManagerLike } from "./CliCommandControlStart.js";

export class CliCommandControlLogs {
    async execute(lifecycle: CliLifecycleManagerLike): Promise<string> {
        return await lifecycle.logs();
    }
}
