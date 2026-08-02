export function resolveSelectedDetailLineId(
    candidateIds: ReadonlyArray<string | undefined>,
    storedId: string | undefined,
): string | undefined {
    let first: string | undefined;
    for (const id of candidateIds) {
        if (id === undefined) {
            continue;
        }
        if (id === storedId) {
            return id;
        }
        first ??= id;
    }
    return first;
}
