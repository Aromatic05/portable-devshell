import { createError, errorCodes } from "@portable-devshell/shared";
import { parse, stringify, type TomlTableWithoutBigInt } from "smol-toml";

export type ConfigTomlDocument = TomlTableWithoutBigInt;

export class ControlTomlCodec {
    decode(source: string): ConfigTomlDocument {
        try {
            return parse(source) as ConfigTomlDocument;
        } catch (error) {
            throw createError({
                code: errorCodes.controlConfigParseFailed,
                cause: error,
                details: { phase: "decode" },
                message: error instanceof Error ? error.message : String(error),
                retryable: false
            });
        }
    }

    encode(document: ConfigTomlDocument): string {
        try {
            return stringify(document);
        } catch (error) {
            throw createError({
                code: errorCodes.controlConfigValidationFailed,
                cause: error,
                details: { phase: "encode" },
                message: error instanceof Error ? error.message : String(error),
                retryable: false
            });
        }
    }
}
