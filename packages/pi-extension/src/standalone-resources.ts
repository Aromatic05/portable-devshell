import { dirname, resolve } from "node:path";

import {
    type BeforeAgentStartEvent,
    type BeforeAgentStartEventResult,
    getAgentDir,
    type SessionStartEvent
} from "@earendil-works/pi-coding-agent";
import type { AgentTarget } from "@portable-devshell/shared";

import {
    expandDevshellPiPromptTemplate,
    transformDevshellPiSkillInput,
    type DevshellPiContextFile,
    type DevshellPiWorkspaceResources
} from "./workspace-resources.js";

interface StandalonePiResourcesApiLike {
    on(
        event: "before_agent_start",
        handler: (event: BeforeAgentStartEvent) => BeforeAgentStartEventResult | Promise<BeforeAgentStartEventResult | void> | void
    ): void;
    on(event: "session_start", handler: (event: SessionStartEvent) => Promise<void> | void): void;
    getCommands(): Array<{
        name: string;
        source: "extension" | "prompt" | "skill";
        sourceInfo: { scope?: string };
    }>;
    registerCommand(name: string, options: {
        description?: string;
        handler: (args: string) => Promise<void> | void;
    }): void;
    sendUserMessage(content: string, options?: { expandPromptTemplates?: boolean }): void;
}

export function appendDevshellRemoteWorkspacePrompt(basePrompt: string, target: AgentTarget): string {
    const remoteWorkspace = `${target.instance}:${target.workspace}`;
    const devshellPrompt = [
        "portable-devshell execution environment:",
        `- The real project workspace is ${remoteWorkspace}.`,
        "- Your local process cwd is only Pi runtime state. It is not the project workspace.",
        "- Use the provided devshell tools for every project filesystem, shell, process, and artifact operation.",
        "- Do not attempt to access the project with local Node.js filesystem/process APIs.",
        "- Tool results come directly from devshell attached to the real project workspace."
    ].join("\n");
    return basePrompt.length === 0 ? devshellPrompt : `${basePrompt}\n\n${devshellPrompt}`;
}

export function replacePiProjectContext(
    systemPrompt: string,
    localContextFiles: readonly DevshellPiContextFile[],
    remoteContextFiles: readonly DevshellPiContextFile[],
    agentDir = getAgentDir()
): string {
    const resolvedAgentDir = resolve(agentDir);
    const userContextFiles = localContextFiles.filter((file) => resolve(dirname(file.path)) === resolvedAgentDir);
    const previousBlock = renderPiProjectContext(localContextFiles);
    const replacementBlock = renderPiProjectContext([...userContextFiles, ...remoteContextFiles]);
    if (previousBlock.length > 0 && systemPrompt.includes(previousBlock)) {
        return systemPrompt.replace(previousBlock, replacementBlock);
    }
    if (remoteContextFiles.length === 0) return systemPrompt;
    const currentWorkingDirectory = "\nCurrent working directory:";
    const markerIndex = systemPrompt.lastIndexOf(currentWorkingDirectory);
    if (markerIndex < 0) return `${systemPrompt}${renderPiProjectContext(remoteContextFiles)}`;
    return `${systemPrompt.slice(0, markerIndex)}${renderPiProjectContext(remoteContextFiles)}${systemPrompt.slice(markerIndex)}`;
}

export function attachStandaloneWorkspaceResources(
    pi: StandalonePiResourcesApiLike,
    target: AgentTarget,
    resources: DevshellPiWorkspaceResources,
    setActiveSkillNames: (names: ReadonlySet<string>) => void
): void {
    pi.on("session_start", () => {
        const protectedCommandNames = new Set(
            pi.getCommands()
                .filter((command) => command.source === "extension" || command.sourceInfo.scope !== "project")
                .map((command) => command.name)
        );
        for (const prompt of resources.prompts) {
            if (protectedCommandNames.has(prompt.name)) continue;
            pi.registerCommand(prompt.name, {
                description: prompt.description,
                handler: (args) => {
                    pi.sendUserMessage(expandDevshellPiPromptTemplate(prompt, args), { expandPromptTemplates: false });
                }
            });
        }
        const activeRemoteSkillNames = new Set<string>();
        for (const skill of resources.skills) {
            const commandName = `skill:${skill.resource.name}`;
            if (protectedCommandNames.has(commandName)) continue;
            activeRemoteSkillNames.add(skill.resource.name);
            pi.registerCommand(commandName, {
                description: skill.resource.description,
                handler: (args) => {
                    const transformed = transformDevshellPiSkillInput([skill], {
                        source: "interactive",
                        text: `/${commandName}${args.length === 0 ? "" : ` ${args}`}`,
                        type: "input"
                    });
                    if (transformed?.action === "transform") {
                        pi.sendUserMessage(transformed.text, { expandPromptTemplates: false });
                    }
                }
            });
        }
        setActiveSkillNames(activeRemoteSkillNames);
    });
    pi.on("before_agent_start", (event) => ({
        systemPrompt: appendDevshellRemoteWorkspacePrompt(
            replacePiProjectContext(
                event.systemPrompt,
                event.systemPromptOptions.contextFiles ?? [],
                resources.contextFiles
            ),
            target
        )
    }));
}

function renderPiProjectContext(contextFiles: readonly DevshellPiContextFile[]): string {
    if (contextFiles.length === 0) return "";
    let block = "\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n";
    for (const file of contextFiles) {
        block += `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>\n\n`;
    }
    return `${block}</project_context>\n`;
}
