export interface AuditStorageLimits {
    maxBytes: number;
    retentionDays: number;
}

export const minimumAuditStorageBytes = 1024 * 1024;

export const defaultAuditStorageLimits: AuditStorageLimits = {
    maxBytes: 64 * 1024 * 1024,
    retentionDays: 7
};

export function resolveAuditStorageLimits(input: Partial<AuditStorageLimits> | undefined): AuditStorageLimits {
    const resolved: AuditStorageLimits = {
        maxBytes: input?.maxBytes ?? defaultAuditStorageLimits.maxBytes,
        retentionDays: input?.retentionDays ?? defaultAuditStorageLimits.retentionDays
    };
    if (!Number.isSafeInteger(resolved.maxBytes) || resolved.maxBytes < minimumAuditStorageBytes) {
        throw new TypeError(`auditStorage.maxBytes must be an integer of at least ${minimumAuditStorageBytes}`);
    }
    if (!Number.isSafeInteger(resolved.retentionDays) || resolved.retentionDays < 1) {
        throw new TypeError("auditStorage.retentionDays must be a positive safe integer");
    }
    return resolved;
}
