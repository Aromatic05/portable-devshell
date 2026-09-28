export const PI_MAIN_AGENT_PATH = "/root/main";

const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export function isPiAgentName(value: string): boolean {
    return AGENT_NAME.test(value);
}

export function createPiChildAgentPath(name: string): string {
    if (!isPiAgentName(name))
        throw new Error(
            "Agent name must start with an alphanumeric character and contain only letters, digits, '.', '_' or '-'.",
        );
    return `${PI_MAIN_AGENT_PATH}/${name}`;
}

export function resolvePiAgentReference(value: string): string {
    const reference = value.trim();
    if (reference === PI_MAIN_AGENT_PATH) return reference;
    if (reference.length === 0) throw new Error("Agent reference is required.");
    if (!reference.includes("/")) return createPiChildAgentPath(reference);
    if (!reference.startsWith(`${PI_MAIN_AGENT_PATH}/`))
        throw new Error(`Agent path must be under ${PI_MAIN_AGENT_PATH}.`);
    const parts = reference.slice(PI_MAIN_AGENT_PATH.length + 1).split("/");
    if (parts.some((part) => !isPiAgentName(part)))
        throw new Error(`Invalid Agent path: ${reference}.`);
    return reference;
}
