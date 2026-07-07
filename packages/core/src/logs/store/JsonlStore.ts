import { mkdir, readFile, appendFile } from "node:fs/promises";
import { dirname } from "node:path";

export class JsonlStore<TRecord> {
    readonly #filePath: string;

    constructor(filePath: string) {
        this.#filePath = filePath;
    }

    async append(record: TRecord): Promise<void> {
        await mkdir(dirname(this.#filePath), { recursive: true });
        await appendFile(this.#filePath, `${JSON.stringify(record)}\n`, "utf8");
    }

    async readAll(): Promise<TRecord[]> {
        let contents = "";

        try {
            contents = await readFile(this.#filePath, "utf8");
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                return [];
            }

            throw error;
        }

        return contents
            .split("\n")
            .filter((line) => line.length > 0)
            .map((line) => JSON.parse(line) as TRecord);
    }
}
