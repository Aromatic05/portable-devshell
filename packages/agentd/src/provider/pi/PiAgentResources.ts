interface PiScopedResource {
    name: string;
    sourceInfo?: {
        scope?: string;
    };
}

interface PiResourceSet<T extends PiScopedResource, D = unknown> {
    diagnostics: D[];
    resources: T[];
}

export function mergeManagedPiProjectSkills<T extends PiScopedResource, D>(
    current: { diagnostics: D[]; skills: T[] },
    remote: readonly T[]
): { diagnostics: D[]; remoteSkillNames: Set<string>; skills: T[] } {
    const merged = replaceProjectResources({
        diagnostics: current.diagnostics,
        resources: current.skills
    }, remote);
    return {
        diagnostics: merged.diagnostics,
        remoteSkillNames: merged.remoteNames,
        skills: merged.resources
    };
}

export function mergeManagedPiProjectPrompts<T extends PiScopedResource, D>(
    current: { diagnostics: D[]; prompts: T[] },
    remote: readonly T[]
): { diagnostics: D[]; prompts: T[] } {
    const merged = replaceProjectResources({
        diagnostics: current.diagnostics,
        resources: current.prompts
    }, remote);
    return {
        diagnostics: merged.diagnostics,
        prompts: merged.resources
    };
}

function replaceProjectResources<T extends PiScopedResource, D>(
    current: PiResourceSet<T, D>,
    remote: readonly T[]
): PiResourceSet<T, D> & { remoteNames: Set<string> } {
    const resources = current.resources.filter((resource) => resource.sourceInfo?.scope !== "project");
    const names = new Set(resources.map((resource) => resource.name));
    const remoteNames = new Set<string>();
    for (const resource of remote) {
        if (names.has(resource.name)) continue;
        names.add(resource.name);
        remoteNames.add(resource.name);
        resources.push(resource);
    }
    return { diagnostics: current.diagnostics, remoteNames, resources };
}
