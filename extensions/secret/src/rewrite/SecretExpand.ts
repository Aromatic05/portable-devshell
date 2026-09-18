const SECRET_REFERENCE = /\$\{SECRET:([^{}]+)\}/gu;

export function secretReferenceNames(text: string): readonly string[] {
    const names: string[] = [];
    const seen = new Set<string>();
    for (const match of text.matchAll(SECRET_REFERENCE)) {
        const name = match[1]!;
        if (seen.has(name)) continue;
        seen.add(name);
        names.push(name);
    }
    return names;
}

export function expandSecretReferences(
    text: string,
    environment: Readonly<Record<string, string>>,
    instance: string,
): string {
    return text.replace(SECRET_REFERENCE, (_reference, name: string) => {
        const value = environment[name];
        if (value === undefined) {
            throw new Error(
                `Secret ${name} is not configured in instance ${instance} env.`,
            );
        }
        return value;
    });
}
