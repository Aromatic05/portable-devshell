import { homedir } from "node:os";
import { join } from "node:path";

export class ControlPathHome {
    readonly controlHomeDir: string;
    readonly configFile: string;
    readonly instancesDir: string;
    readonly oauthDir: string;
    readonly reverseDir: string;

    constructor(homeDirectory = homedir()) {
        this.controlHomeDir = join(homeDirectory, ".devshell", "control");
        this.configFile = join(this.controlHomeDir, "config.toml");
        this.instancesDir = join(this.controlHomeDir, "instances");
        this.oauthDir = join(this.controlHomeDir, "oauth");
        this.reverseDir = join(this.controlHomeDir, "reverse");
    }

    instanceConfigFile(name: string): string {
        return join(this.instancesDir, `${name}.toml`);
    }

    reverseCredentialFile(name: string): string {
        return join(this.reverseDir, `${name}.json`);
    }
}
