import { dirname, resolve } from "node:path";

import {
    type BeforeAgentStartEvent,
    type BeforeAgentStartEventResult,
    getAgentDir,
    type SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import {
    expandDevshellPiPromptTemplate,
    transformDevshellPiSkillInput,
    type DevshellPiContextFile,
    type DevshellPiWorkspaceResources,
} from "./WorkspaceResources.js";
import type { DevshellPiTarget } from "./Target.js";

interface StandalonePiResourcesApiLike {
    on(
        event: "before_agent_start",
        handler: (
            event: BeforeAgentStartEvent,
        ) =>
            | BeforeAgentStartEventResult
            | Promise<BeforeAgentStartEventResult | void>
            | void,
    ): void;
    on(
        event: "session_start",
        handler: (event: SessionStartEvent) => Promise<void> | void,
    ): void;
    getCommands(): Array<{
        name: string;
        source: "extension" | "prompt" | "skill";
        sourceInfo: { scope?: string };
    }>;
    registerCommand(
        name: string,
        options: {
            description?: string;
            handler: (args: string) => Promise<void> | void;
        },
    ): void;
    sendUserMessage(
        content: string,
        options?: { expandPromptTemplates?: boolean },
    ): void;
}

export function buildDevshellPiSystemPrompt(
    options: BeforeAgentStartEvent["systemPromptOptions"],
    target: DevshellPiTarget,
    resources: DevshellPiWorkspaceResources,
    agentDir = getAgentDir(),
): string {
    const remoteWorkspace = `${target.instance}:${target.workspace}`;
    const sections = [
        [
            "You are a coding agent working in a DevShell workspace.",
            "",
            `Workspace: ${remoteWorkspace}. Use DevShell tools for all project filesystem, shell, process, and artifact operations.`,
            "",
            "Engineering workflow:",
            "- Prefer authoritative sources; inspect historical or superseded material only when needed.",
            "- Gather only enough context for the next concrete implementation decision, then act.",
            "- Batch related read-only investigation and prefer coherent edits over alternating model/tool one step at a time.",
            "- Do not re-read unchanged or just-edited content without a concrete reason.",
            "- Validate narrowly first; broaden only after the relevant checks pass.",
            "- Once requirements are covered and validation passes, do one bounded final review; without a concrete new issue, finish.",
        ].join("\n"),
        options.customPrompt?.trim(),
        options.appendSystemPrompt?.trim(),
        renderPiProjectContext([
            ...selectUserContextFiles(
                options.contextFiles ?? [],
                agentDir,
            ),
            ...resources.contextFiles,
        ]),
        renderDevshellPiSkills(resources.skills),
    ];
    return sections
        .filter(
            (section): section is string =>
                typeof section === "string" && section.length > 0,
        )
        .join("\n\n");
}

export function attachStandaloneWorkspaceResources(
    pi: StandalonePiResourcesApiLike,
    target: DevshellPiTarget,
    resources: DevshellPiWorkspaceResources,
    setActiveSkillNames: (names: ReadonlySet<string>) => void,
): void {
    pi.on("session_start", () => {
        const protectedCommandNames = new Set(
            pi
                .getCommands()
                .filter(
                    (command) =>
                        command.source === "extension" ||
                        command.sourceInfo.scope !== "project",
                )
                .map((command) => command.name),
        );
        for (const prompt of resources.prompts) {
            if (protectedCommandNames.has(prompt.name)) continue;
            pi.registerCommand(prompt.name, {
                description: prompt.description,
                handler: (args) => {
                    pi.sendUserMessage(
                        expandDevshellPiPromptTemplate(prompt, args),
                        { expandPromptTemplates: false },
                    );
                },
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
                        type: "input",
                    });
                    if (transformed?.action === "transform") {
                        pi.sendUserMessage(transformed.text, {
                            expandPromptTemplates: false,
                        });
                    }
                },
            });
        }
        setActiveSkillNames(activeRemoteSkillNames);
    });
    pi.on("before_agent_start", (event) => ({
        systemPrompt: buildDevshellPiSystemPrompt(
            event.systemPromptOptions,
            target,
            resources,
        ),
    }));
}

function selectUserContextFiles(
    contextFiles: readonly DevshellPiContextFile[],
    agentDir: string,
): DevshellPiContextFile[] {
    const resolvedAgentDir = resolve(agentDir);
    return contextFiles.filter(
        (file) => resolve(dirname(file.path)) === resolvedAgentDir,
    );
}

function renderPiProjectContext(
    contextFiles: readonly DevshellPiContextFile[],
): string {
    if (contextFiles.length === 0) return "";
    let block =
        "<project_context>\n\nProject-specific instructions and guidelines:\n\n";
    for (const file of contextFiles) {
        block += `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>\n\n`;
    }
    return `${block}</project_context>`;
}

function renderDevshellPiSkills(
    skills: readonly DevshellPiWorkspaceResources["skills"][number][],
): string {
    const visible = skills.filter(
        (skill) => !skill.resource.disableModelInvocation,
    );
    if (visible.length === 0) return "";
    const lines = [
        "The following project skills provide specialized instructions for specific tasks.",
        "Use file_read to load a skill file when the task matches its description.",
        "Resolve relative references against the skill directory.",
        "",
        "<available_skills>",
    ];
    for (const { resource } of visible) {
        lines.push("  <skill>");
        lines.push(`    <name>${escapeXml(resource.name)}</name>`);
        lines.push(
            `    <description>${escapeXml(resource.description)}</description>`,
        );
        lines.push(`    <location>${escapeXml(resource.filePath)}</location>`);
        lines.push("  </skill>");
    }
    lines.push("</available_skills>");
    return lines.join("\n");
}

function escapeXml(value: string): string {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&apos;");
}
