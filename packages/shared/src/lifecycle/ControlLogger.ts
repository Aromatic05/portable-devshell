import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { ControlPathHome } from "./path/ControlPathHome.js";

export class ControlLogger {
    readonly #logsDir: string;
    readonly path: string;

    constructor(homeDirectory?: string) {
        const paths = new ControlPathHome(homeDirectory);
        this.#logsDir = join(paths.controlHomeDir, "logs");
        this.path = join(this.#logsDir, "control.log");
    }

    async info(message: string): Promise<void> {
        await this.write("INFO", message);
    }

    async error(message: string): Promise<void> {
        await this.write("ERROR", message);
    }

    async readAll(): Promise<string> {
        try {
            return await readFile(this.path, "utf8");
        } catch (error) {
            if (isFileMissingError(error)) {
                return "";
            }

            throw error;
        }
    }

    async write(level: string, message: string): Promise<void> {
        const entry = `[${new Date().toISOString()}] ${level} ${message}\n`;
        await mkdir(this.#logsDir, { recursive: true });
        await appendFile(this.path, entry, "utf8");
    }
}

function isFileMissingError(error: unknown): error is NodeJS.ErrnoException {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
