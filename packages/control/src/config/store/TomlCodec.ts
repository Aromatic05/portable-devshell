import {
    createRemoteError,
    controlErrorCodes,
} from "@portable-devshell/shared";
import { parse, stringify, type TomlTableWithoutBigInt } from "smol-toml";

export type ConfigTomlDocument = TomlTableWithoutBigInt;

export class ControlConfigTomlCodec {
    decode(source: string): ConfigTomlDocument {
        try {
            return parse(source) as ConfigTomlDocument;
        } catch (error) {
            throw createRemoteError({
                code: controlErrorCodes.configParseFailed,
                cause: error,
                details: { phase: "decode" },
                message: error instanceof Error ? error.message : String(error),
                retryable: false,
            });
        }
    }

    encode(document: ConfigTomlDocument): string {
        try {
            return stringify(document);
        } catch (error) {
            throw createRemoteError({
                code: controlErrorCodes.configValidationFailed,
                cause: error,
                details: { phase: "encode" },
                message: error instanceof Error ? error.message : String(error),
                retryable: false,
            });
        }
    }
}
