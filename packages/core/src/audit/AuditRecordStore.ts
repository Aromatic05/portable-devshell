export interface AuditRecordStore<TRecord> {
    append(record: TRecord): Promise<void>;
    readAll(): Promise<TRecord[]>;
    readFromSeq?(fromSeq: number, limit?: number, maxDecodedBytes?: number): Promise<TRecord[]>;
    readHighWater?(): Promise<number>;
    readTail?(limit: number, maxDecodedBytes?: number): Promise<TRecord[]>;
}
