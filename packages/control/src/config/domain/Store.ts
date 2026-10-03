import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

import type { JsonValue } from "@portable-devshell/shared";

export class ConfigDomainStore {
    readonly #filePath: string;

    constructor(filePath: string) {
        this.#filePath = filePath;
    }

    async read(): Promise<Readonly<Record<string, JsonValue>> | undefined> {
        let source: string;
        try {
            source = await readFile(this.#filePath, "utf8");
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT")
                return undefined;
            throw error;
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(source);
        } catch (error) {
            throw new Error(
                `Config domain file ${this.#filePath} is not valid JSON.`,
                { cause: error },
            );
        }
        if (
            typeof parsed !== "object" ||
            parsed === null ||
            Array.isArray(parsed)
        ) {
            throw new TypeError(
                `Config domain file ${this.#filePath} must contain a JSON object.`,
            );
        }
        return parsed as Readonly<Record<string, JsonValue>>;
    }

    async write(value: Readonly<Record<string, JsonValue>>): Promise<void> {
        const directory = dirname(this.#filePath);
        await mkdir(directory, { mode: 0o700, recursive: true });
        const temporary = `${this.#filePath}.${process.pid}.${randomUUID()}.tmp`;
        const file = await open(temporary, "wx", 0o600);
        try {
            await file.writeFile(`${JSON.stringify(value)}\n`, "utf8");
            await file.sync();
        } catch (error) {
            await file.close().catch(() => undefined);
            await rm(temporary, { force: true }).catch(() => undefined);
            throw error;
        }
        await file.close();
        try {
            await rename(temporary, this.#filePath);
        } catch (error) {
            await rm(temporary, { force: true }).catch(() => undefined);
            throw error;
        }
        if (process.platform !== "win32") {
            const parent = await open(directory, "r");
            try {
                await parent.sync();
            } finally {
                await parent.close();
            }
        }
    }
}
