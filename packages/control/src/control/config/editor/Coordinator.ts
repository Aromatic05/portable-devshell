import type { McpHost, McpInstanceGateway } from "@portable-devshell/mcp";
import {
    applyConfigMcpPatch,
    applyConfigWebPatch,
    normalizeConfigGlobalDraft,
    parseConfigBatchUpdateRequest,
    parseConfigUpdateMcpRequest,
    parseConfigUpdateWebRequest,
    type ControlConfig,
    type JsonValue,
} from "@portable-devshell/shared";

import { McpEndpointFactory } from "../../../composition/mcp/Endpoint.js";
import { HttpEndpointPreflight } from "../../../server/endpoint/Http.js";
import { InstanceFactory } from "../../instance/create/Factory.js";
import type { InstanceRegistry } from "../../instance/registry/Registry.js";
import {
    diffConfigPaths,
    parseConfigPath,
    setConfigPathValue,
} from "../Path.js";
import {
    ConfigEngine,
    type ConfigEngineOptions,
    type ConfigRuntimeChangeSet,
} from "../Engine.js";
import { InstanceConfigCoordinator } from "../instance/Coordinator.js";

export type { ConfigRuntimeChangeSet } from "../Engine.js";

interface ConfigEditorCoordinatorOptions extends ConfigEngineOptions {
    cleanupDebtFile?: string;
    getMcpHost?: () => McpHost | undefined;
    getMcpInstanceGateway?: () => McpInstanceGateway | undefined;
    instanceConfigMapper?: InstanceFactory;
    instanceRegistry: InstanceRegistry;
    mcpEndpointConfigMapper?: McpEndpointFactory;
}

export class ConfigEditorCoordinator {
    readonly #engine: ConfigEngine;
    readonly #instances: InstanceConfigCoordinator;

    constructor(options: ConfigEditorCoordinatorOptions) {
        this.#engine = new ConfigEngine({
            ...options,
            runtimePreflight:
                options.runtimePreflight ?? new HttpEndpointPreflight(),
        });
        this.#instances = new InstanceConfigCoordinator({
            cleanupDebtFile: options.cleanupDebtFile,
            engine: this.#engine,
            getMcpHost: options.getMcpHost,
            getMcpInstanceGateway: options.getMcpInstanceGateway,
            instanceConfigMapper: options.instanceConfigMapper,
            instanceRegistry: options.instanceRegistry,
            mcpEndpointConfigMapper: options.mcpEndpointConfigMapper,
        });
    }

    registerInstanceDeleteRetirement(
        retire: (instance: ControlConfig["instances"][number]) => Promise<void>,
    ): () => void {
        return this.#instances.registerInstanceDeleteRetirement(retire);
    }

    registerInstanceDisableRetirement(
        retire: (instance: ControlConfig["instances"][number]) => Promise<void>,
    ): () => void {
        return this.#instances.registerInstanceDisableRetirement(retire);
    }

    registerInstanceGenerationRetirement(
        retire: (instance: ControlConfig["instances"][number]) => Promise<void>,
    ): () => void {
        return this.#instances.registerInstanceGenerationRetirement(retire);
    }

    registerInstanceDisabled(
        listener: (instance: ControlConfig["instances"][number]) => Promise<void>,
    ): () => void {
        return this.#instances.registerInstanceDisabled(listener);
    }

    registerInstanceDeleted(
        listener: (instance: ControlConfig["instances"][number]) => Promise<void>,
    ): () => void {
        return this.#instances.registerInstanceDeleted(listener);
    }

    async assertInstanceCleanupSettled(instance: string): Promise<void> {
        await this.#instances.assertInstanceCleanupSettled(instance);
    }

    async reconcileCleanupDebt(instance?: string): Promise<void> {
        await this.#instances.reconcileCleanupDebt(instance);
    }

    getConfigView(): JsonValue {
        return this.#engine.getConfigView();
    }

    validateConfigDraft(params: JsonValue | undefined): JsonValue {
        return this.#engine.validateConfigDraft(params);
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
                    throw new TypeError(`Config path ${path} is not owned by Core.`);
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
            if (mcpChanged || webChanged)
                await this.#engine.preflight(previous, validated);
            await this.#engine.persist(validated);
            const hotApplied = await this.#engine.applyRuntimeOrRestore(
                previous,
                validated,
                runtimeChanges(previous, validated, {
                    instanceAuth: false,
                    mcp: mcpChanged,
                    web: webChanged,
                }),
            );
            this.#engine.finalizeApplyResult(
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
                hotApplied,
            );
        });
    }

    async updateConfig(params: JsonValue | undefined): Promise<JsonValue> {
        return await this.#engine.runExclusive(
            async () => await this.#updateConfig(params),
        );
    }

    async #updateConfig(params: JsonValue | undefined): Promise<JsonValue> {
        const request = this.#engine.readInput(() =>
            parseConfigBatchUpdateRequest(params),
        );
        if (request.mcp !== undefined) this.#engine.requireDomain("mcp");
        if (request.web !== undefined) this.#engine.requireDomain("web");
        const currentConfig = this.#engine.current;
        const plan =
            request.instance === undefined
                ? undefined
                : await this.#instances.createUpdatePlan(
                      request.instance,
                      currentConfig,
                  );
        if (plan !== undefined) this.#instances.assertUpdateReady(plan);

        const global = this.#engine.readInput(() =>
            normalizeConfigGlobalDraft({
                control: currentConfig.control,
                mcp: applyConfigMcpPatch(currentConfig.mcp, request.mcp ?? {}),
                web: applyConfigWebPatch(currentConfig.web, request.web ?? {}),
            }),
        );
        const nextConfig = this.#engine.validateConfig({
            ...currentConfig,
            instances:
                plan === undefined
                    ? currentConfig.instances
                    : currentConfig.instances.map((entry) =>
                          entry.name === plan.target ? plan.instance : entry,
                      ),
            mcp: global.mcp,
            web: global.web,
        });
        if (request.mcp !== undefined || request.web !== undefined) {
            await this.#engine.preflight(currentConfig, nextConfig);
        }

        const preparedDescriptor =
            plan === undefined ? undefined : this.#instances.prepareUpdate(plan);
        if (plan === undefined) {
            await this.#engine.persist(nextConfig);
        } else {
            await this.#instances.persistPreparedConfig(
                nextConfig,
                plan,
                preparedDescriptor,
            );
        }
        const runtimeChangeSet = runtimeChanges(currentConfig, nextConfig, {
            instanceAuth: plan?.authChanged ?? false,
            mcp: request.mcp !== undefined,
            web: request.web !== undefined,
        });
        const hotApplied =
            plan === undefined
                ? runtimeChangeSet.mcp || runtimeChangeSet.web
                    ? await this.#engine.applyRuntimeOrRestore(
                          currentConfig,
                          nextConfig,
                          runtimeChangeSet,
                      )
                    : false
                : await this.#instances.applyPreparedUpdate(
                      plan,
                      currentConfig,
                      nextConfig,
                      preparedDescriptor,
                      runtimeChangeSet,
                  );
        if (plan !== undefined) {
            await this.#instances.cleanupPreparedUpdate(
                plan,
                preparedDescriptor,
            );
        }

        const changes = [
            ...(plan === undefined
                ? []
                : [{ kind: "instance.updated" as const, target: plan.target }]),
            ...(request.mcp === undefined
                ? []
                : [{ kind: "mcp.endpoint.updated" as const, target: "mcp" }]),
            ...(request.web === undefined
                ? []
                : [{ kind: "web.updated" as const, target: "web" }]),
        ];
        return this.#engine.finalizeApplyResult(
            currentConfig,
            nextConfig,
            changes,
            hotApplied,
        );
    }

    async updateInstanceConfig(
        params: JsonValue | undefined,
    ): Promise<JsonValue> {
        return await this.#instances.updateInstanceConfig(params);
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
        const nextConfig = this.#engine.validateConfig({
            ...currentConfig,
            mcp: global.mcp,
        });

        await this.#engine.preflight(currentConfig, nextConfig);
        await this.#engine.persist(nextConfig);
        const hotApplied = await this.#engine.applyRuntimeOrRestore(
            currentConfig,
            nextConfig,
            runtimeChanges(currentConfig, nextConfig, {
                instanceAuth: false,
                mcp: true,
                web: false,
            }),
        );
        return this.#engine.finalizeApplyResult(
            currentConfig,
            nextConfig,
            [{ kind: "mcp.endpoint.updated", target: "mcp" }],
            hotApplied,
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
        const nextConfig = this.#engine.validateConfig({
            ...currentConfig,
            web: global.web,
        });
        await this.#engine.preflight(currentConfig, nextConfig);
        await this.#engine.persist(nextConfig);
        const hotApplied = await this.#engine.applyRuntimeOrRestore(
            currentConfig,
            nextConfig,
            runtimeChanges(currentConfig, nextConfig, {
                instanceAuth: false,
                mcp: false,
                web: true,
            }),
        );
        return this.#engine.finalizeApplyResult(
            currentConfig,
            nextConfig,
            [{ kind: "web.updated", target: "web" }],
            hotApplied,
        );
    }

    async deleteInstance(params: JsonValue | undefined): Promise<JsonValue> {
        return await this.#instances.deleteInstance(params);
    }

    async enableInstance(params: JsonValue | undefined): Promise<JsonValue> {
        return await this.#instances.enableInstance(params);
    }

    async disableInstance(params: JsonValue | undefined): Promise<JsonValue> {
        return await this.#instances.disableInstance(params);
    }
}

function runtimeChanges(
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
