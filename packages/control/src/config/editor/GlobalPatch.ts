import {
    applyConfigMcpPatch,
    applyConfigWebPatch,
    normalizeConfigGlobalDraft,
    parseConfigUpdateMcpRequest,
    parseConfigUpdateWebRequest,
    type ControlConfig,
    type JsonValue,
} from "@portable-devshell/shared";
import { diffConfigPaths, parseConfigPath, setConfigPathValue } from "../Path.js";
import type { ConfigEngine } from "../engine/index.js";
import type { ConfigRuntimeChangeSet } from "../engine/Api.js";
import type { ConfigApplyChange } from "../engine/Result.js";

export class ConfigGlobalPatch {
    readonly #engine: ConfigEngine;

    constructor(engine: ConfigEngine) {
        this.#engine = engine;
    }

    async updateCorePaths(
        patch: Readonly<Record<string, JsonValue>>,
    ): Promise<void> {
        await this.#engine.runExclusive(async () => {
            const previous = this.#engine.current;
            const next = structuredClone(previous);
            const root = next as unknown as Record<string, JsonValue>;
            for (const [path, value] of Object.entries(patch)) {
                const parsed = parseConfigPath(path);
                const definition = this.#engine.requireDomain(parsed.domain);
                if (definition.owner.kind !== "core") {
                    throw new TypeError(
                        `Config path ${path} is not owned by Core.`,
                    );
                }
                const domain = root[parsed.domain];
                if (
                    typeof domain !== "object" ||
                    domain === null ||
                    Array.isArray(domain)
                ) {
                    throw new TypeError(
                        `Core Config domain ${parsed.domain} is not an object.`,
                    );
                }
                setConfigPathValue(
                    domain as Record<string, JsonValue>,
                    parsed.segments,
                    value,
                );
            }
            const validated = this.#engine.validateConfig(next);
            const mcpChanged =
                diffConfigPaths(previous.mcp, validated.mcp, "mcp").length > 0;
            const webChanged =
                diffConfigPaths(previous.web, validated.web, "web").length > 0;
            const controlChanged =
                diffConfigPaths(previous.control, validated.control, "control")
                    .length > 0;
            if (!mcpChanged && !webChanged && !controlChanged) return;
            await this.#commit(
                previous,
                validated,
                [
                    ...(mcpChanged
                        ? [
                              {
                                  kind: "mcp.endpoint.updated" as const,
                                  target: "mcp",
                              },
                          ]
                        : []),
                    ...(webChanged
                        ? [{ kind: "web.updated" as const, target: "web" }]
                        : []),
                ],
                { instanceAuth: false, mcp: mcpChanged, web: webChanged },
                mcpChanged || webChanged,
            );
        });
    }

    async updateMcpConfig(params: JsonValue | undefined): Promise<JsonValue> {
        return await this.#engine.runExclusive(
            async () => await this.#updateMcpConfig(params),
        );
    }

    async #updateMcpConfig(params: JsonValue | undefined): Promise<JsonValue> {
        this.#engine.requireDomain("mcp");
        const request = this.#engine.readInput(() =>
            parseConfigUpdateMcpRequest(params),
        );
        const currentConfig = this.#engine.current;
        const global = this.#engine.readInput(() =>
            normalizeConfigGlobalDraft({
                control: currentConfig.control,
                mcp: applyConfigMcpPatch(currentConfig.mcp, request.patch),
            }),
        );
        const nextConfig: ControlConfig = {
            ...currentConfig,
            mcp: global.mcp,
        };

        return await this.#commit(
            currentConfig,
            nextConfig,
            [{ kind: "mcp.endpoint.updated", target: "mcp" }],
            { instanceAuth: false, mcp: true, web: false },
        );
    }

    async updateWebConfig(params: JsonValue | undefined): Promise<JsonValue> {
        return await this.#engine.runExclusive(
            async () => await this.#updateWebConfig(params),
        );
    }

    async #updateWebConfig(params: JsonValue | undefined): Promise<JsonValue> {
        this.#engine.requireDomain("web");
        const request = this.#engine.readInput(() =>
            parseConfigUpdateWebRequest(params),
        );
        const currentConfig = this.#engine.current;
        const global = this.#engine.readInput(() =>
            normalizeConfigGlobalDraft({
                control: currentConfig.control,
                mcp: currentConfig.mcp,
                web: applyConfigWebPatch(currentConfig.web, request.patch),
            }),
        );
        const nextConfig: ControlConfig = {
            ...currentConfig,
            web: global.web,
        };
        return await this.#commit(
            currentConfig,
            nextConfig,
            [{ kind: "web.updated", target: "web" }],
            { instanceAuth: false, mcp: false, web: true },
        );
    }

    async #commit(
        previous: ControlConfig,
        next: ControlConfig,
        changes: readonly ConfigApplyChange[],
        runtimeChanges: ConfigRuntimeChangeSet,
        preflight = true,
    ): Promise<JsonValue> {
        return await this.#engine.commit(
            previous,
            next,
            changes,
            coupledRuntimeChanges(previous, next, runtimeChanges),
            preflight,
        );
    }
}

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
