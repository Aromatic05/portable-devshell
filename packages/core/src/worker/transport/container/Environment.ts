export function workerTransportContainerEnvironmentArgs(
    environmentKeys: readonly string[] | undefined
): string[] {
    return (environmentKeys ?? []).flatMap((key) => ["-e", key]);
}
