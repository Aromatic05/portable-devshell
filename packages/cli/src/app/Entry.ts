import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CliMain } from "./Main.js";

export function isCliEntrypoint(
    moduleUrl: string,
    argvPath: string | undefined,
): boolean {
    if (argvPath === undefined) return false;
    try {
        return (
            realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argvPath)
        );
    } catch {
        return false;
    }
}

if (isCliEntrypoint(import.meta.url, process.argv[1])) {
    process.exit(await new CliMain().run(process.argv.slice(2)));
}
