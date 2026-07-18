import { existsSync } from "node:fs";
import { resolve } from "node:path";

export function resolvePnpmCommand(options = {}) {
    const environment = options.environment ?? process.env;
    const platform = options.platform ?? process.platform;
    const nodeExecutable = options.nodeExecutable ?? process.execPath;

    if (platform !== "win32") {
        return { args: [], command: "pnpm" };
    }

    const candidates = [
        environment.PORTABLE_DEVSHELL_PNPM_CLI,
        environment.npm_execpath,
        environment.PNPM_HOME === undefined
            ? undefined
            : resolve(environment.PNPM_HOME, "..", "pnpm", "bin", "pnpm.cjs"),
        environment.PNPM_HOME === undefined
            ? undefined
            : resolve(environment.PNPM_HOME, "..", "pnpm", "dist", "pnpm.cjs")
    ];
    const cli = candidates.find((candidate) =>
        typeof candidate === "string"
        && candidate.length > 0
        && candidate.toLowerCase().endsWith(".cjs")
        && existsSync(candidate)
    );
    if (cli === undefined) {
        throw new Error(
            "Cannot locate pnpm.cjs on Windows. Run packaging through pnpm/action-setup or set PORTABLE_DEVSHELL_PNPM_CLI."
        );
    }
    return { args: [cli], command: nodeExecutable };
}
