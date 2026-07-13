import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";

import {
    asInstanceName,
    createError,
    errorCodes,
    type ReverseEnrollmentState
} from "@portable-devshell/shared";

import { ControlPathHome } from "../control/path/ControlPathHome.js";

const DEVICE_CODE_LIFETIME_MS = 10 * 60 * 1000;

interface ReverseCredentialRecord {
    consumedAt?: string;
    consumedDeviceCodeHash?: string;
    deviceCodeExpiresAt?: string;
    deviceCodeHash?: string;
    enrollmentState: ReverseEnrollmentState;
    instance: string;
    revokedAt?: string;
    tokenHash?: string;
    version: 1;
}

export interface ReverseEnrollmentCredential {
    deviceToken: string;
    instance: string;
}

export interface StoredReverseDeviceCode {
    deviceCode: string;
    expiresAt: string;
    instance: import("@portable-devshell/shared").InstanceName;
}

export class ReverseCredentialStore {
    readonly #paths: ControlPathHome;
    #operationQueue: Promise<unknown> = Promise.resolve();

    constructor(homeDirectory?: string) {
        this.#paths = new ControlPathHome(homeDirectory);
    }

    async createDeviceCode(instance: string): Promise<StoredReverseDeviceCode> {
        return await this.#exclusive(async () => {
            asInstanceName(instance);
            const deviceCode = formatDeviceCode(randomBytes(10));
            const expiresAt = new Date(Date.now() + DEVICE_CODE_LIFETIME_MS).toISOString();
            const previous = await this.#readOptional(instance);
            await this.#write({
                enrollmentState: "pending",
                instance,
                version: 1,
                deviceCodeExpiresAt: expiresAt,
                deviceCodeHash: hashSecret(normalizeDeviceCode(deviceCode)),
                ...(previous?.tokenHash === undefined ? {} : { tokenHash: previous.tokenHash })
            });
            return {
                deviceCode,
                expiresAt,
                instance: asInstanceName(instance)
            };
        });
    }

    async consumeDeviceCode(deviceCode: string): Promise<ReverseEnrollmentCredential> {
        return await this.#exclusive(async () => {
            const normalized = normalizeDeviceCode(deviceCode);
            const hash = hashSecret(normalized);
            const records = await this.#readAll();
            const record = records.find(
                (candidate) =>
                    safeHashEquals(candidate.deviceCodeHash, hash) ||
                    safeHashEquals(candidate.consumedDeviceCodeHash, hash)
            );

            if (record === undefined) {
                throw reverseError(errorCodes.reverseDeviceCodeInvalid, "Device code is invalid.", false);
            }
            if (safeHashEquals(record.consumedDeviceCodeHash, hash)) {
                throw reverseError(errorCodes.reverseDeviceCodeConsumed, "Device code has already been consumed.", false, {
                    instance: record.instance
                });
            }
            if (
                record.deviceCodeExpiresAt === undefined ||
                Date.parse(record.deviceCodeExpiresAt) <= Date.now()
            ) {
                throw reverseError(errorCodes.reverseDeviceCodeExpired, "Device code has expired.", false, {
                    instance: record.instance
                });
            }

            const deviceToken = randomBytes(32).toString("base64url");
            await this.#write({
                consumedAt: new Date().toISOString(),
                consumedDeviceCodeHash: hash,
                enrollmentState: "enrolled",
                instance: record.instance,
                tokenHash: hashSecret(deviceToken),
                version: 1
            });
            return {
                deviceToken,
                instance: record.instance
            };
        });
    }

    async authenticate(instance: string, deviceToken: string): Promise<boolean> {
        const record = await this.#readOptional(instance);
        if (
            record === undefined ||
            record.revokedAt !== undefined ||
            record.tokenHash === undefined
        ) {
            return false;
        }
        return safeHashEquals(record.tokenHash, hashSecret(deviceToken));
    }

    async rotateToken(instance: string): Promise<string> {
        return await this.#exclusive(async () => {
            const record = await this.#readRequired(instance);
            if (record.enrollmentState !== "enrolled" || record.revokedAt !== undefined) {
                throw reverseError(errorCodes.reverseDeviceTokenRevoked, "Device credential is not active.", false, {
                    instance
                });
            }
            const token = randomBytes(32).toString("base64url");
            await this.#write({
                ...record,
                tokenHash: hashSecret(token)
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
                tokenHash: undefined
            });
        });
    }

    async enrollmentState(instance: string): Promise<ReverseEnrollmentState> {
        return (await this.#readOptional(instance))?.enrollmentState ?? "pending";
    }

    async #readRequired(instance: string): Promise<ReverseCredentialRecord> {
        const record = await this.#readOptional(instance);
        if (record !== undefined) {
            return record;
        }
        throw reverseError(errorCodes.reverseDeviceTokenInvalid, "Reverse credential does not exist.", false, {
            instance
        });
    }

    async #readOptional(instance: string): Promise<ReverseCredentialRecord | undefined> {
        try {
            return parseRecord(await readFile(this.#paths.reverseCredentialFile(instance), "utf8"));
        } catch (error) {
            if (isMissingFile(error)) {
                return undefined;
            }
            throw error;
        }
    }

    async #readAll(): Promise<ReverseCredentialRecord[]> {
        try {
            const entries = await readdir(this.#paths.reverseDir, { withFileTypes: true });
            const records: ReverseCredentialRecord[] = [];
            for (const entry of entries) {
                if (!entry.isFile() || !entry.name.endsWith(".json")) {
                    continue;
                }
                records.push(parseRecord(await readFile(`${this.#paths.reverseDir}/${entry.name}`, "utf8")));
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
        await writeFile(
            this.#paths.reverseCredentialFile(record.instance),
            `${JSON.stringify(record, null, 2)}\n`,
            { encoding: "utf8", mode: 0o600 }
        );
    }

    async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
        const next = this.#operationQueue.then(operation, operation);
        this.#operationQueue = next.then(
            () => undefined,
            () => undefined
        );
        return await next;
    }
}

function parseRecord(raw: string): ReverseCredentialRecord {
    const value = JSON.parse(raw) as Partial<ReverseCredentialRecord>;
    if (
        value.version !== 1 ||
        typeof value.instance !== "string" ||
        (value.enrollmentState !== "pending" &&
            value.enrollmentState !== "enrolled" &&
            value.enrollmentState !== "revoked")
    ) {
        throw new Error("Invalid reverse credential record.");
    }
    return value as ReverseCredentialRecord;
}

function normalizeDeviceCode(value: string): string {
    return value.replaceAll("-", "").trim().toUpperCase();
}

function formatDeviceCode(bytes: Buffer): string {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let value = "";
    for (const byte of bytes) {
        value += alphabet[byte % alphabet.length];
    }
    return `${value.slice(0, 5)}-${value.slice(5, 10)}`;
}

function hashSecret(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}

function safeHashEquals(left: string | undefined, right: string): boolean {
    if (left === undefined || left.length !== right.length) {
        return false;
    }
    return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function reverseError(
    code: string,
    message: string,
    retryable: boolean,
    details?: Record<string, string>
) {
    return createError({
        code: code as (typeof errorCodes)[keyof typeof errorCodes],
        ...(details === undefined ? {} : { details }),
        message,
        retryable
    });
}
