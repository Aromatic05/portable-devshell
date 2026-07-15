export interface AuditRecordStore<TRecord> {
    append(record: TRecord): Promise<void>;
    readAll(): Promise<TRecord[]>;
    readHighWater?(): Promise<number>;
}
