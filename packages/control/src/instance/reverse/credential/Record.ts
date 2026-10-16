import { createHash, timingSafeEqual } from "node:crypto";

import type { ReverseEnrollmentState } from "@portable-devshell/shared";

export interface ReverseCredentialRecord {
    consumedAt?: string;
    consumedDeviceCodeHash?: string;
    deviceCodeExpiresAt?: string;
    deviceCodeHash?: string;
    enrollmentState: ReverseEnrollmentState;
    instance: string;
    previousTokenHash?: string;
    revokedAt?: string;
    tokenHash?: string;
    version: 1;
}

export function parseCredentialRecord(raw: string): ReverseCredentialRecord {
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

export function normalizeDeviceCode(value: string): string {
    return value.replaceAll("-", "").trim().toUpperCase();
}

export function formatDeviceCode(bytes: Buffer): string {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let value = "";
    for (const byte of bytes) {
        value += alphabet[byte % alphabet.length];
    }
    return `${value.slice(0, 5)}-${value.slice(5, 10)}`;
}

export function hashSecret(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}

export function safeHashEquals(
    left: string | undefined,
    right: string,
): boolean {
    if (left === undefined || left.length !== right.length) {
        return false;
    }
    return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export function credentialMatches(
    record: ReverseCredentialRecord | undefined,
    deviceToken: string,
): boolean {
    return (
        record !== undefined &&
        record.revokedAt === undefined &&
        (safeHashEquals(record.tokenHash, hashSecret(deviceToken)) ||
            safeHashEquals(record.previousTokenHash, hashSecret(deviceToken)))
    );
}
