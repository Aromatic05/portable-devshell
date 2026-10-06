import type { TodoReadInput } from "@portable-devshell/shared";

import type { TuiDomainSession } from "./Client.js";

export async function refreshTuiInstance(
    domains: TuiDomainSession,
    instance: string,
): Promise<void> {
    const runtime = domains.runtime(instance);
    await Promise.all([
        runtime.load(),
        domains.approval(instance).load(),
        domains.todo(instance).load(),
        domains.goals.load(instance),
    ]);
}

export async function refreshTuiAudit(
    domains: TuiDomainSession,
    instance: string,
): Promise<void> {
    const runtime = domains.runtime(instance);
    await Promise.all([
        domains.context.refresh(),
        runtime.load().then(() => runtime.readLogs()),
        domains.approval(instance).load(),
        domains.toolCalls.load(instance),
        domains.messageHistory.refreshInstance(instance),
        domains.messages.refreshInstance(instance),
    ]);
}

export async function refreshTuiMessages(
    domains: TuiDomainSession,
): Promise<void> {
    await Promise.all([domains.instances.refresh(), domains.context.refresh()]);
    const instances = domains.instances.state.instances.map(({ name }) => name);
    await Promise.all([
        domains.messageHistory.load(instances),
        domains.messagePreferences.refresh(),
        domains.messages.load(instances),
    ]);
}

export async function refreshTuiTodo(
    domains: TuiDomainSession,
    instance: string,
    input?: TodoReadInput,
): Promise<void> {
    await Promise.all([
        domains.todo(instance).load(input),
        domains.goals.load(instance),
    ]);
}

export async function refreshTuiAll(domains: TuiDomainSession): Promise<void> {
    await Promise.all([
        domains.config.refresh(),
        domains.instances.refresh(),
        domains.context.refresh(),
        domains.artifact.refresh(),
        domains.overview.refresh(),
        domains.mcp.refresh(),
        domains.extension.refreshCatalogs(),
        domains.messagePreferences.refresh(),
    ]);
}
