export interface AuditRecordStore<TRecord> {
    append(record: TRecord): Promise<void>;
    readAll(): TRecord[];
}

export interface AuditSequenceStore<TRecord> extends AuditRecordStore<TRecord> {
    readFromSeq(fromSeq: number, limit?: number, maxDecodedBytes?: number): TRecord[];
    readHighWater(): number;
    readTail(limit: number, maxDecodedBytes?: number): TRecord[];
}
