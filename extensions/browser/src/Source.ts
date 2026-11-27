/** Browser data remains owned by either DevShell or the user's browser. */
export const browserChannels = [
    "chrome", "chrome-beta", "chrome-dev", "chrome-canary",
    "msedge", "msedge-beta", "msedge-dev", "msedge-canary",
] as const;
export type BrowserChannel = typeof browserChannels[number];
export type BrowserSource =
    | { kind: "managed" }
    | { kind: "extension"; channel: BrowserChannel; profileDirectory?: string };

export function parseSource(value: unknown): BrowserSource {
    if (value && typeof value === "object" && "kind" in value) {
        if (value.kind === "managed") return { kind: "managed" };
        if (value.kind === "extension" && "channel" in value &&
            browserChannels.includes(value.channel as BrowserChannel)) {
            const directory = "profileDirectory" in value ? value.profileDirectory : undefined;
            if (directory !== undefined && (typeof directory !== "string" ||
                !directory.trim() || directory === "." || directory === ".." ||
                /[\\/\x00-\x1f]/.test(directory)))
                throw new Error("Specify a browser profile directory name, not a path.");
            return {
                kind: "extension", channel: value.channel as BrowserChannel,
                ...(directory !== undefined ? { profileDirectory: directory } : {}),
            };
        }
    }
    throw new Error("Select a managed browser or a supported Chrome/Edge channel.");
}
