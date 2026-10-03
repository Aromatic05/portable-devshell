export interface ContextPresentationPort {
    revokeContext(ctxId: string): Promise<void>;
    revokeInstance(instance: string): Promise<void>;
}
