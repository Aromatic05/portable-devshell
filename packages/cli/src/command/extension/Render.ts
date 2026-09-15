import type {
    CliCommandDescriptor,
    ExtensionRuntimeRecord,
} from "@portable-devshell/shared";

export function renderExtensionUsage(): string {
    return [
        "Usage:",
        "  devshell extension install <bundle-or-directory>",
        "  devshell extension update <bundle-or-directory>",
        "  devshell extension remove <extensionId> [--purge]",
        "  devshell extension list [--json]",
        "  devshell extension inspect <extensionId>",
        "  devshell extension enable <extensionId>",
        "  devshell extension disable <extensionId>",
        "  devshell extension reload <extensionId>",
        "",
        "Installed Extension commands use `devshell <extension-id> [args...]`.",
    ].join("\n");
}

export function renderExtensionCommandUsage(
    command: CliCommandDescriptor,
): string {
    return [
        command.title,
        "",
        "Usage:",
        `  devshell ${command.usage ?? command.id}`,
        ...(command.summary === undefined ? [] : ["", command.summary]),
        "",
        `Extension: ${command.extensionId}`,
    ].join("\n");
}

export function renderExtensionList(
    records: readonly ExtensionRuntimeRecord[],
): string {
    if (records.length === 0) return "no extensions\n";
    return `${records
        .map((record) =>
            [
                record.id,
                record.version ?? "-",
                record.enabled ? record.state : "disabled",
            ].join("\t"),
        )
        .join("\n")}\n`;
}
