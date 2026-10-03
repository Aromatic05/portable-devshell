import {
    applyConfigMcpPatch,
    applyConfigWebPatch,
    normalizeConfigGlobalDraft,
    parseConfigBatchUpdateRequest,
    type ControlConfig,
    type JsonValue,
} from "@portable-devshell/shared";
import type { ConfigEngine, ConfigRuntimeChangeSet } from "../engine/index.js";
import type { ConfigApplyChange } from "../engine/Result.js";
import type { InstanceReconfigurationCoordinator, InstanceConfigUpdatePlan } from "./instance/Update.js";
import { coupledRuntimeChanges } from "./GlobalPatch.js";

export class ConfigBatchEditor {
    readonly #engine: ConfigEngine;
    readonly #updates: InstanceReconfigurationCoordinator;

    constructor(engine: ConfigEngine, updates: InstanceReconfigurationCoordinator) {
        this.#engine = engine;
        this.#updates = updates;
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
                : await this.#updates.createUpdatePlan(
                      request.instance,
                      currentConfig,
                  );
        if (plan !== undefined) this.#updates.assertUpdateReady(plan);

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
        plan?: InstanceConfigUpdatePlan,
    ): Promise<JsonValue> {
        const runtimeChanges = coupledRuntimeChanges(previous, next, requestedRuntimeChanges);
        if (plan === undefined) {
            return await this.#engine.commit(previous, next, changes, runtimeChanges, preflight);
        }
        const validated = this.#engine.validateConfig(next);
        if (preflight) await this.#engine.preflight(previous, validated);
        const preparedDescriptor = this.#updates.prepareUpdate(plan);
        await this.#updates.persistPreparedConfig(validated, plan, preparedDescriptor);
        const hotApplied = await this.#updates.applyPreparedUpdate(
            plan,
            previous,
            validated,
            preparedDescriptor,
            runtimeChanges,
        );
        await this.#updates.cleanupPreparedUpdate(plan, preparedDescriptor);
        return this.#engine.finalizeApplyResult(previous, validated, changes, hotApplied);
    }
}
