export interface WebState {
    error?: string;
    notice?: string;
    operations: Record<string, "pending">;
}

export function createInitialWebState(): WebState {
    return { operations: {} };
}
