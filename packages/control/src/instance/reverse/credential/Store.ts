import type {
    ReverseEnrollmentCredential,
    StoredReverseDeviceCode,
} from "../Api.js";
import { randomBytes, randomUUID } from "node:crypto";
import {
    access,
    mkdir,
    open,
    readFile,
    readdir,
    rename,
    rm,
} from "node:fs/promises";

import {
    asInstanceName,
    createRemoteError,
    runtimeErrorCodes,
    type ReverseEnrollmentState,
} from "@portable-devshell/shared";

import { ControlPathHome } from "@portable-devshell/shared";
import {
    createReverseCredentialFileSecurity,
    type ReverseCredentialFileSecurity,
} from "./FileSecurity.js";
import {
    credentialMatches,
    formatDeviceCode,
    hashSecret,
    normalizeDeviceCode,
    parseCredentialRecord,
    safeHashEquals,
    type ReverseCredentialRecord,
} from "./Record.js";

const DEVICE_CODE_LIFETIME_MS = 10 * 60 * 1000;

export class ReverseCredentialStore {
    readonly #fileSecurity: ReverseCredentialFileSecurity;
    readonly #paths: ControlPathHome;
    #operationQueue: Promise<unknown> = Promise.resolve();

    constructor(
        homeDirectory?: string,
        fileSecurity: ReverseCredentialFileSecurity = createReverseCredentialFileSecurity(),
    ) {
        this.#fileSecurity = fileSecurity;
        this.#paths = new ControlPathHome(homeDirectory);
    }

    async createDeviceCode(instance: string): Promise<StoredReverseDeviceCode> {
        return await this.#exclusive(async () => {
            asInstanceName(instance);
            const deviceCode = formatDeviceCode(randomBytes(10));
            const expiresAt = new Date(
                Date.now() + DEVICE_CODE_LIFETIME_MS,
            ).toISOString();
            const previous = await this.#readOptional(instance);
            await this.#write({
                enrollmentState: "pending",
                instance,
                version: 1,
                deviceCodeExpiresAt: expiresAt,
                deviceCodeHash: hashSecret(normalizeDeviceCode(deviceCode)),
                ...(previous?.tokenHash === undefined
                    ? {}
                    : { tokenHash: previous.tokenHash }),
            });
            return {
                deviceCode,
                expiresAt,
                instance: asInstanceName(instance),
            };
        });
    }

    async consumeDeviceCode(
        deviceCode: string,
    ): Promise<ReverseEnrollmentCredential> {
        return await this.#exclusive(async () => {
            const normalized = normalizeDeviceCode(deviceCode);
            const hash = hashSecret(normalized);
            const records = await this.#readAll();
            const record = records.find(
                (candidate) =>
                    safeHashEquals(candidate.deviceCodeHash, hash) ||
                    safeHashEquals(candidate.consumedDeviceCodeHash, hash),
            );

            if (record === undefined) {
                throw reverseError(
                    runtimeErrorCodes.reverseDeviceCodeInvalid,
                    "Device code is invalid.",
                    false,
                );
            }
            if (safeHashEquals(record.consumedDeviceCodeHash, hash)) {
                throw reverseError(
                    runtimeErrorCodes.reverseDeviceCodeConsumed,
                    "Device code has already been consumed.",
                    false,
                    {
                        instance: record.instance,
                    },
                );
            }
            if (
                record.deviceCodeExpiresAt === undefined ||
                Date.parse(record.deviceCodeExpiresAt) <= Date.now()
            ) {
                throw reverseError(
                    runtimeErrorCodes.reverseDeviceCodeExpired,
                    "Device code has expired.",
                    false,
                    {
                        instance: record.instance,
                    },
                );
            }

            const deviceToken = randomBytes(32).toString("base64url");
            await this.#write({
                consumedAt: new Date().toISOString(),
                consumedDeviceCodeHash: hash,
                enrollmentState: "enrolled",
                instance: record.instance,
                tokenHash: hashSecret(deviceToken),
                version: 1,
            });
            return {
                deviceToken,
                instance: record.instance,
            };
        });
    }

    async authenticate(
        instance: string,
        deviceToken: string,
    ): Promise<boolean> {
        const record = await this.#readOptional(instance);
        return credentialMatches(record, deviceToken);
    }

    async withAuthenticatedToken(
        instance: string,
        deviceToken: string,
        operation: () => Promise<void>,
    ): Promise<boolean> {
        return await this.#exclusive(async () => {
            const record = await this.#readOptional(instance);
            if (!credentialMatches(record, deviceToken)) {
                return false;
            }
            await operation();
            return true;
        });
    }

    async rotateToken(instance: string): Promise<string> {
        return await this.#exclusive(async () => {
            const record = await this.#readRequired(instance);
            if (
                record.tokenHash === undefined ||
                record.revokedAt !== undefined
            ) {
                throw reverseError(
                    runtimeErrorCodes.reverseDeviceTokenRevoked,
                    "Device credential is not active.",
                    false,
                    {
                        instance,
                    },
                );
            }
            const token = randomBytes(32).toString("base64url");
            await this.#write({
                ...record,
                tokenHash: hashSecret(token),
            });
            return token;
        });
    }

    async revoke(instance: string): Promise<void> {
        await this.#exclusive(async () => {
            const record = await this.#readRequired(instance);
            await this.#write({
                ...record,
                deviceCodeExpiresAt: undefined,
                deviceCodeHash: undefined,
                enrollmentState: "revoked",
                revokedAt: new Date().toISOString(),
                tokenHash: undefined,
            });
        });
    }

    async retire(instance: string): Promise<boolean> {
        return await this.#exclusive(async () => {
            const record = await this.#readOptional(instance);
            if (record === undefined) return false;
            await this.#write({
                ...record,
                deviceCodeExpiresAt: undefined,
                deviceCodeHash: undefined,
                enrollmentState: "revoked",
                revokedAt: new Date().toISOString(),
                tokenHash: undefined,
            });
            return true;
        });
    }

    async enrollmentState(instance: string): Promise<ReverseEnrollmentState> {
        return (
            (await this.#readOptional(instance))?.enrollmentState ?? "pending"
        );
    }

    async #readRequired(instance: string): Promise<ReverseCredentialRecord> {
        const record = await this.#readOptional(instance);
        if (record !== undefined) {
            return record;
        }
        throw reverseError(
            runtimeErrorCodes.reverseDeviceTokenInvalid,
            "Reverse credential does not exist.",
            false,
            {
                instance,
            },
        );
    }

    async #readOptional(
        instance: string,
    ): Promise<ReverseCredentialRecord | undefined> {
        try {
            return parseCredentialRecord(
                await readFile(
                    this.#paths.reverseCredentialFile(instance),
                    "utf8",
                ),
            );
        } catch (error) {
            if (isMissingFile(error)) {
                return undefined;
            }
            throw error;
        }
    }

    async #readAll(): Promise<ReverseCredentialRecord[]> {
        try {
            const entries = await readdir(this.#paths.reverseDir, {
                withFileTypes: true,
            });
            const records: ReverseCredentialRecord[] = [];
            for (const entry of entries) {
                if (!entry.isFile() || !entry.name.endsWith(".json")) {
                    continue;
                }
                const path = `${this.#paths.reverseDir}/${entry.name}`;
                let record: ReverseCredentialRecord;
                try {
                    record = parseCredentialRecord(
                        await readFile(path, "utf8"),
                    );
                } catch (error) {
                    // One malformed record must not block enrollment of other instances.
                    if (
                        error instanceof SyntaxError ||
                        (error instanceof Error &&
                            error.message ===
                                "Invalid reverse credential record.")
                    ) {
                        console.warn(
                            `Ignoring invalid reverse credential record: ${path}`,
                        );
                        continue;
                    }
                    throw error;
                }
                records.push(record);
            }
            return records;
        } catch (error) {
            if (isMissingFile(error)) {
                return [];
            }
            throw error;
        }
    }

    async #write(record: ReverseCredentialRecord): Promise<void> {
        await mkdir(this.#paths.reverseDir, { recursive: true, mode: 0o700 });
        await this.#fileSecurity.secureDirectory(this.#paths.reverseDir);
        const credentialFile = this.#paths.reverseCredentialFile(
            record.instance,
        );
        if (await pathExists(credentialFile)) {
            await this.#fileSecurity.secureFile(credentialFile);
        }
        const temporary = `${credentialFile}.${process.pid}.${randomUUID()}.tmp`;
        const file = await open(temporary, "wx", 0o600);
        try {
            await file.writeFile(
                `${JSON.stringify(record, null, 2)}\n`,
                "utf8",
            );
            await file.sync();
        } catch (error) {
            await file.close().catch(() => undefined);
            await rm(temporary, { force: true }).catch(() => undefined);
            throw error;
        }
        await file.close();
        try {
            await this.#fileSecurity.secureFile(temporary);
            await rename(temporary, credentialFile);
            if (process.platform !== "win32") {
                const directory = await open(this.#paths.reverseDir, "r");
                try {
                    await directory.sync();
                } finally {
                    await directory.close();
                }
            }
        } catch (error) {
            await rm(temporary, { force: true }).catch(() => undefined);
            throw error;
        }
    }

    async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
        const next = this.#operationQueue.then(operation, operation);
        this.#operationQueue = next.then(
            () => undefined,
            () => undefined,
        );
        return await next;
    }
}

async function pathExists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch (error) {
        if (isMissingFile(error)) return false;
        throw error;
    }
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
    return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
    );
}

function reverseError(
    code: string,
    message: string,
    retryable: boolean,
    details?: Record<string, string>,
) {
    return createRemoteError({
        code,
        ...(details === undefined ? {} : { details }),
        message,
        retryable,
    });
}
