import { homedir } from "node:os";
import { join } from "node:path";

import type { InstanceName } from "@portable-devshell/shared";

export class InstancePaths {
    readonly auditDatabaseFile: string;
    readonly instanceRootDir: string;
    readonly controlWorkerDir: string;
    readonly legacyApprovalsFile: string;
    readonly legacyEventsFile: string;
    readonly legacyLogsFile: string;
    readonly legacyToolCallsFile: string;
    readonly todoFile: string;
    readonly workerConfigFile: string;
    readonly workerLogFile: string;
    readonly workerPidFile: string;

    constructor(instanceName: InstanceName, homeDirectory = homedir()) {
        this.instanceRootDir = join(homeDirectory, ".devshell", instanceName);
        this.controlWorkerDir = join(this.instanceRootDir, "control-worker");
        this.auditDatabaseFile = join(this.controlWorkerDir, "audit.sqlite3");
        this.legacyApprovalsFile = join(this.controlWorkerDir, "approvals.jsonl");
        this.legacyEventsFile = join(this.controlWorkerDir, "events.jsonl");
        this.legacyLogsFile = join(this.controlWorkerDir, "logs.jsonl");
        this.legacyToolCallsFile = join(this.controlWorkerDir, "tool-calls.jsonl");
        this.todoFile = join(this.controlWorkerDir, "todo.json");
        this.workerConfigFile = join(this.instanceRootDir, "config.toml");
        this.workerLogFile = join(this.instanceRootDir, "logs", "worker.log");
        this.workerPidFile = join(this.instanceRootDir, "state", "worker.pid");
    }
}
