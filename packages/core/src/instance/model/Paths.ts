import { homedir } from "node:os";
import { join } from "node:path";

import type { InstanceName } from "@portable-devshell/shared";

export class InstancePaths {
    readonly homeDirectory: string;
    readonly auditDatabaseFile: string;
    readonly instanceRootDir: string;
    readonly controlWorkerDir: string;
    readonly containerAdoptionDatabaseFile: string;
    readonly messageDatabaseFile: string;
    readonly goalsFile: string;
    readonly todoFile: string;
    readonly waitsFile: string;
    readonly workerConfigFile: string;
    readonly workerLogFile: string;
    readonly workerPidFile: string;

    constructor(instanceName: InstanceName, homeDirectory = homedir()) {
        this.homeDirectory = homeDirectory;
        this.instanceRootDir = join(homeDirectory, ".devshell", instanceName);
        this.controlWorkerDir = join(this.instanceRootDir, "control-worker");
        this.containerAdoptionDatabaseFile = join(this.controlWorkerDir, "container-adoption.sqlite3");
        this.messageDatabaseFile = join(
            this.controlWorkerDir,
            "message.sqlite3",
        );
        this.goalsFile = join(this.controlWorkerDir, "goals.json");
        this.auditDatabaseFile = join(this.controlWorkerDir, "audit.sqlite3");
        this.todoFile = join(this.controlWorkerDir, "todo.json");
        this.waitsFile = join(this.controlWorkerDir, "detached-waits.json");
        this.workerConfigFile = join(this.instanceRootDir, "config.toml");
        this.workerLogFile = join(this.instanceRootDir, "logs", "worker.log");
        this.workerPidFile = join(this.instanceRootDir, "state", "worker.pid");
    }
}
