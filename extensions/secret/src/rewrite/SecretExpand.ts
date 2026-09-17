const SECRET_REFERENCE = /\$\{SECRET:([^{}]+)\}/gu;

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
