import { homedir } from "node:os";
import { join } from "node:path";

import type { InstanceName } from "../../../../shared/dist/types/InstanceName.js";

export class InstancePaths {
    readonly instanceRootDir: string;
    readonly controlWorkerDir: string;
    readonly eventsFile: string;
    readonly toolCallsFile: string;
    readonly logsFile: string;
    readonly workerConfigFile: string;
    readonly workerLogFile: string;
    readonly workerPidFile: string;

    constructor(instanceName: InstanceName, homeDirectory = homedir()) {
        this.instanceRootDir = join(homeDirectory, ".devshell", instanceName);
        this.controlWorkerDir = join(this.instanceRootDir, "control-worker");
        this.eventsFile = join(this.controlWorkerDir, "events.jsonl");
        this.toolCallsFile = join(this.controlWorkerDir, "tool-calls.jsonl");
        this.logsFile = join(this.controlWorkerDir, "logs.jsonl");
        this.workerConfigFile = join(this.instanceRootDir, "config.toml");
        this.workerLogFile = join(this.instanceRootDir, "logs", "worker.log");
        this.workerPidFile = join(this.instanceRootDir, "state", "worker.pid");
    }
}
