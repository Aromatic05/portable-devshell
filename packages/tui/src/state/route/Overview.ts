export function selectTuiOverviewInstanceName(
    focusId: string | undefined,
): string | undefined {
    const prefix = "overview-instance:";
    return focusId?.startsWith(prefix)
        ? focusId.slice(prefix.length)
        : undefined;
}
