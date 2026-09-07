import type {
    ExtensionActivation,
    ExtensionContext,
    ExtensionJsonValue,
    ExtensionRpcHandler
} from "@portable-devshell/extension";

import { executeAgentCommand } from "./AgentCommand.js";
import { readAgentId } from "./AgentInput.js";
import { AgentExtensionRuntime } from "./AgentRuntime.js";

export async function activate(context: ExtensionContext): Promise<ExtensionActivation> {
    const runtime = new AgentExtensionRuntime(context);
    const rpc: Record<string, ExtensionRpcHandler> = {
        list: () => runtime.list().map(recordToJson),
        get: (input) => {
            const record = runtime.get(readAgentId(input));
            return record === undefined ? null : recordToJson(record);
        },
        start: async (input) => recordToJson(await runtime.start(input)),
        prompt: async (input) => {
            await runtime.prompt(input);
            return {};
        },
        steer: async (input) => {
            await runtime.steer(input);
            return {};
        },
        followUp: async (input) => {
            await runtime.followUp(input);
            return {};
        },
        abort: async (input) => {
            await runtime.abort(input);
            return {};
        },
        reload: async (input) => {
            await runtime.reload(input);
            return {};
        },
        stop: async (input) => recordToJson(await runtime.stop(input))
    };
    return {
        command: async (argv, invocation) => await executeAgentCommand(runtime, argv, invocation),
        dispose: async () => await runtime.dispose(),
        lifecycle: {
            onInstanceRetire: async (event) => await runtime.retireInstance(event.instance)
        },
        rpc,
        web: {
            kind: "proxy",
            resolveUpstream: () => runtime.webUpstream()
        }
    };
}

function recordToJson(record: ReturnType<AgentExtensionRuntime["list"]>[number]): ExtensionJsonValue {
    return {
        agentId: record.agentId,
        provider: record.provider,
        providerVersion: record.providerVersion,
        state: record.state,
        target: {
            instance: record.target.instance,
            workspace: record.target.workspace
        }
    };
}
