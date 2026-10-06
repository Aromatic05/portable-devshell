import {
    applyConfigMcpPatch,
    applyConfigWebPatch,
    normalizeConfigGlobalDraft,
    parseConfigBatchUpdateRequest,
    type ConfigUpdateInstanceRequest,
    type ControlConfig,
    type JsonValue,
} from "@portable-devshell/shared";
import type { ConfigEngine } from "../engine/index.js";
import type { ConfigRuntimeChangeSet } from "../engine/Api.js";
import type { ConfigApplyChange } from "../engine/Result.js";
import { coupledRuntimeChanges } from "./GlobalPatch.js";

export interface ConfigBatchInstancePlan {
    readonly authChanged: boolean;
    readonly instance: ControlConfig["instances"][number];
    readonly target: string;
    assertReady(): void;
    commit(
        previous: ControlConfig,
        next: ControlConfig,
        runtimeChanges: ConfigRuntimeChangeSet,
    ): Promise<boolean>;
}

export interface ConfigBatchInstancePort {
    createPlan(
        request: ConfigUpdateInstanceRequest,
        currentConfig: ControlConfig,
    ): Promise<ConfigBatchInstancePlan>;
}

export class ConfigBatchEditor {
    readonly #engine: ConfigEngine;
    readonly #instances?: ConfigBatchInstancePort;

    constructor(engine: ConfigEngine, instances?: ConfigBatchInstancePort) {
        this.#engine = engine;
        this.#instances = instances;
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
                : await this.#requireInstances().createPlan(
                      request.instance,
                      currentConfig,
                  );
        plan?.assertReady();

        const global = this.#engine.readInput(() =>
            normalizeConfigGlobalDraft({
                control: currentConfig.control,
                mcp: applyConfigMcpPatch(currentConfig.mcp, request.mcp ?? {}),
                web: applyConfigWebPatch(currentConfig.web, request.web ?? {}),
            }),
        );
        const nextConfig: ControlConfig = {
            ...currentConfig,
            instances:
                plan === undefined
                    ? currentConfig.instances
                    : currentConfig.instances.map((entry) =>
                          entry.name === plan.target ? plan.instance : entry,
                      ),
            mcp: global.mcp,
            web: global.web,
        };
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
        return await this.#commit(
            currentConfig,
            nextConfig,
            changes,
            {
                instanceAuth: plan?.authChanged ?? false,
                mcp: request.mcp !== undefined,
                web: request.web !== undefined,
            },
            request.mcp !== undefined || request.web !== undefined,
            plan,
        );
    }

    async #commit(
        previous: ControlConfig,
        next: ControlConfig,
        changes: readonly ConfigApplyChange[],
        requestedRuntimeChanges: ConfigRuntimeChangeSet,
        preflight = true,
        plan?: ConfigBatchInstancePlan,
    ): Promise<JsonValue> {
        const runtimeChanges = coupledRuntimeChanges(previous, next, requestedRuntimeChanges);
        if (plan === undefined) {
            return await this.#engine.commit(previous, next, changes, runtimeChanges, preflight);
        }
        const validated = this.#engine.validateConfig(next);
        if (preflight) await this.#engine.preflight(previous, validated);
        const hotApplied = await plan.commit(
            previous,
            validated,
            runtimeChanges,
        );
        return this.#engine.finalizeApplyResult(previous, validated, changes, hotApplied);
    }

    #requireInstances(): ConfigBatchInstancePort {
        if (this.#instances !== undefined) return this.#instances;
        throw new Error("Instance Config updates are not available.");
    }
}
