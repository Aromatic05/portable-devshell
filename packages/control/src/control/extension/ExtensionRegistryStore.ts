import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import {
    cloneExtensionRegistry,
    emptyExtensionRegistry,
    parseExtensionRegistry,
    type ExtensionRegistrySnapshot
} from "./ExtensionRegistryModel.js";

export interface ExtensionRegistryPort {
    read(): Promise<ExtensionRegistrySnapshot>;
    write(snapshot: ExtensionRegistrySnapshot): Promise<void>;
}

export class ExtensionRegistryStore implements ExtensionRegistryPort {
    readonly #filePath: string;

    constructor(filePath: string) {
        this.#filePath = filePath;
    }

    async read(): Promise<ExtensionRegistrySnapshot> {
        const source = await readFile(this.#filePath, "utf8").catch((error: unknown) => {
            if (isMissing(error)) return undefined;
            throw error;
        });
        if (source === undefined) return emptyExtensionRegistry();
        return parseExtensionRegistry(JSON.parse(source) as unknown);
    }

    async write(snapshot: ExtensionRegistrySnapshot): Promise<void> {
        const validated = parseExtensionRegistry(cloneExtensionRegistry(snapshot));
        const directory = dirname(this.#filePath);
        await mkdir(directory, { mode: 0o700, recursive: true });
        const temporary = `${this.#filePath}.${process.pid}.${randomUUID()}.tmp`;
        const handle = await open(temporary, "wx", 0o600);
        try {
            await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, "utf8");
            await handle.sync();
        } catch (error) {
            await handle.close().catch(() => undefined);
            await unlink(temporary).catch(() => undefined);
            throw error;
        }
        await handle.close();
        try {
            await rename(temporary, this.#filePath);
            if (process.platform !== "win32") {
                const directoryHandle = await open(directory, "r");
                try {
                    await directoryHandle.sync();
                } finally {
                    await directoryHandle.close();
                }
            }
        } catch (error) {
            await unlink(temporary).catch(() => undefined);
            throw error;
        }
    }
}

function isMissing(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
