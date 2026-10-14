/** Memory is a built-in Context command implemented by Comment. Only this
 * command is available regardless of optional model extension selections. */
export function modelCommandAvailable(
    command: { readonly extensionId: string; readonly id: string },
    enabledExtensions: readonly string[],
): boolean {
    return enabledExtensions.includes(command.extensionId) ||
        (command.extensionId === "comment" && command.id === "memory");
}
