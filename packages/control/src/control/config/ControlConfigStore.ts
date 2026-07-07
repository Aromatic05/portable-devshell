import { mkdir, readFile, writeFile } from "node:fs/promises";

import { createDefaultControlConfig } from "./ControlConfigDefaults.js";
import { ControlConfigTomlCodec, type ControlConfig } from "./ControlConfigTomlCodec.js";
import { ControlConfigValidator } from "./ControlConfigValidator.js";
import { ControlPathHome } from "../path/ControlPathHome.js";

export class ControlConfigStore {
    readonly #codec: ControlConfigTomlCodec;
    readonly #validator: ControlConfigValidator;

    constructor(options?: { codec?: ControlConfigTomlCodec; validator?: ControlConfigValidator }) {
        this.#codec = options?.codec ?? new ControlConfigTomlCodec();
        this.#validator = options?.validator ?? new ControlConfigValidator();
    }

    async readOrCreate(homeDirectory?: string): Promise<ControlConfig> {
        const paths = new ControlPathHome(homeDirectory);

        try {
            const source = await readFile(paths.configFile, "utf8");
            return this.#validator.validate(this.#codec.decode(source));
        } catch (error) {
            if (!isFileMissingError(error)) {
                throw error;
            }
        }

        const config = this.#validator.validate(createDefaultControlConfig());
        await this.write(config, homeDirectory);
        return config;
    }

    async write(config: ControlConfig, homeDirectory?: string): Promise<void> {
        const paths = new ControlPathHome(homeDirectory);
        const validated = this.#validator.validate(config);

        await mkdir(paths.controlHomeDir, { recursive: true });
        await writeFile(paths.configFile, this.#codec.encode(validated), "utf8");
    }
}

function isFileMissingError(error: unknown): error is NodeJS.ErrnoException {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
