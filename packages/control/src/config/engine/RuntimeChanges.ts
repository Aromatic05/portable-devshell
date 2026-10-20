import type { ControlConfig } from "@portable-devshell/shared";
import { diffConfigPaths } from "../Path.js";
import type { ConfigRuntimeChangeSet } from "./Api.js";

export function coupledRuntimeChanges(
    previous: ControlConfig,
    next: ControlConfig,
    changes: ConfigRuntimeChangeSet,
): ConfigRuntimeChangeSet {
    if (!changes.mcp || changes.web) return changes;
    const oauth2Changed =
        diffConfigPaths(previous.mcp.oauth2, next.mcp.oauth2, "mcp.oauth2")
            .length > 0;
    const webUsesOAuth2 = [previous, next].some(
        (config) => config.web.enabled && config.web.auth.mode === "oauth2",
    );
    return oauth2Changed && webUsesOAuth2 ? { ...changes, web: true } : changes;
}
