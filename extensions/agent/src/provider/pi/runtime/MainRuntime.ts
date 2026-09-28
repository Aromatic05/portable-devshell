import {
    createDevshellPiExtension,
    type DevshellPiToolSession,
    type PiExtensionApiLike,
} from "../adapt/Bridge.js";
import {
    PI_TMUX_TOOL_DOMAIN,
    PiToolExposureController,
    type PiToolExposureSurface,
} from "../adapt/ToolExposure.js";
import { PiAgentProfileCatalog } from "../profile/Loader.js";
import {
    PiSubagentRuntime,
    type PiSubagentGuiLike,
    type PiSubagentMainState,
} from "../subagent/Runtime.js";
import {
    attachPiSubagentTools,
    PI_SUBAGENT_TOOL_NAMES,
} from "../subagent/Tools.js";
import type { PiModelRuntimeLike, PiSdkModule } from "./Sdk.js";

export class PiMainRuntime {
    readonly #subagents: PiSubagentRuntime;
    readonly #tools: DevshellPiToolSession;
    #toolExposure?: PiToolExposureController;

    constructor(options: {
        agentDir: string;
        gui: PiSubagentGuiLike;
        localCwd: string;
        modelRuntime: PiModelRuntimeLike;
        sdk: PiSdkModule;
        tools: DevshellPiToolSession;
    }) {
        this.#tools = options.tools;
        this.#subagents = new PiSubagentRuntime({
            agentDir: options.agentDir,
            gui: options.gui,
            localCwd: options.localCwd,
            modelRuntime: options.modelRuntime,
            onChildrenChanged: (hasAliveChildren) =>
                this.#toolExposure?.setExpanded("agent", hasAliveChildren),
            profiles: new PiAgentProfileCatalog(options.agentDir, options.tools),
            sdk: options.sdk,
            tools: options.tools,
        });
    }

    extension(): (pi: PiExtensionApiLike) => Promise<void> {
        const base = createDevshellPiExtension(this.#tools, {
            closeSessionOnShutdown: false,
        });
        return async (pi) => {
            await base(pi);
            attachPiSubagentTools(pi, this.#subagents);
        };
    }

    bindMain(
        main: () => PiSubagentMainState,
        surface: PiToolExposureSurface,
    ): void {
        this.#subagents.bindMain(main);
        this.#toolExposure = new PiToolExposureController(surface, {
            agent: {
                expanded: PI_SUBAGENT_TOOL_NAMES,
                gateway: ["agent_spawn"],
            },
            tmux: PI_TMUX_TOOL_DOMAIN,
        });
    }

    notifyMainInput(): void {
        this.#subagents.notifyMainInput();
    }

    observeToolResult(toolName: string, isError: boolean): void {
        this.#toolExposure?.observeToolResult(toolName, isError);
    }

    async close(): Promise<void> {
        await this.#subagents.close();
        this.#toolExposure?.close();
    }
}
