import { homedir } from "node:os";
import { join } from "node:path";

export class ControlPathHome {
    readonly controlHomeDir: string;
    readonly artifactsDir: string;
    readonly configFile: string;
    readonly contextsFile: string;
    readonly instancesDir: string;
    readonly oauthDir: string;
    readonly reverseDir: string;

    constructor(homeDirectory = homedir()) {
        this.controlHomeDir = join(homeDirectory, ".devshell", "control");
        this.artifactsDir = join(this.controlHomeDir, "artifacts");
        this.configFile = join(this.controlHomeDir, "config.toml");
        this.contextsFile = join(this.controlHomeDir, "contexts.json");
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
