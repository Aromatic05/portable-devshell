import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { ControlPathHome } from "./path/ControlPathHome.js";

export class ControlPidFile {
    readonly path: string;

    constructor(homeDirectory?: string) {
        this.path = join(new ControlPathHome(homeDirectory).controlHomeDir, "control.pid");
    }

    async read(): Promise<number | undefined> {
        try {
            const source = (await readFile(this.path, "utf8")).trim();

            if (source.length === 0) {
                return undefined;
            }

            const pid = Number.parseInt(source, 10);
            return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
        } catch (error) {
            if (isFileMissingError(error)) {
                return undefined;
            }

            throw error;
        }
    }

    async write(pid = process.pid): Promise<void> {
        await mkdir(dirname(this.path), { recursive: true });
        await writeFile(this.path, `${pid}\n`, "utf8");
    }

    async remove(): Promise<void> {
        await rm(this.path, { force: true });
    }
}

function isFileMissingError(error: unknown): error is NodeJS.ErrnoException {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
