import { asInstanceName, type InstanceName } from "@portable-devshell/shared";

export interface AgentWorkerTarget {
    instance: InstanceName;
    workspace: string;
}

/**
 * Parses the compact Agent target syntax: <worker-instance>:<workspace>.
 *
 * Workspace absoluteness is intentionally validated by the remote Worker,
 * because the target filesystem may use path semantics different from the
 * machine hosting the Agent Extension.
 */
export function parseAgentWorkerTarget(value: string): AgentWorkerTarget {
    if (value.length === 0 || value.trim() !== value) {
        throw new TypeError("Agent target must not be empty or surrounded by whitespace.");
    }

    const delimiter = value.indexOf(":");
    if (delimiter <= 0) {
        throw new TypeError("Agent target must use <worker-instance>:<workspace>.");
    }

    const instance = value.slice(0, delimiter);
    const workspace = value.slice(delimiter + 1);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(instance)) {
        throw new TypeError("Agent target has an invalid worker instance name.");
    }
    if (workspace.length === 0) {
        throw new TypeError("Agent target workspace must not be empty.");
    }

    return {
        instance: asInstanceName(instance),
        workspace
    };
}

export function renderAgentWorkerTarget(target: AgentWorkerTarget): string {
    return `${target.instance}:${target.workspace}`;
}
