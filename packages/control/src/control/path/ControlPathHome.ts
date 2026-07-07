import { homedir } from "node:os";
import { join } from "node:path";

export class ControlPathHome {
    readonly controlHomeDir: string;
    readonly configFile: string;

    constructor(homeDirectory = homedir()) {
        this.controlHomeDir = join(homeDirectory, ".devshell", "control");
        this.configFile = join(this.controlHomeDir, "config.toml");
    }
}
