export async function cleanupInOrder(
    ...steps: Array<() => Promise<unknown> | unknown>
): Promise<void> {
    const errors: unknown[] = [];
    for (const step of steps) {
        try {
            await step();
        } catch (error) {
            errors.push(error);
        }
    }
    if (errors.length > 0) {
        throw new AggregateError(errors, "Test cleanup failed.");
    }
}
