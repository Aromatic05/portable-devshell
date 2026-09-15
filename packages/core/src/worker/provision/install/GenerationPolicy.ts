export const WORKER_GENERATION_RETENTION_DAYS = 7;
export const WORKER_GENERATION_RETENTION_MS = WORKER_GENERATION_RETENTION_DAYS * 24 * 60 * 60 * 1_000;

export function isWorkerGenerationName(value: string): boolean {
    return /^[0-9a-f]{64}$/u.test(value);
}
