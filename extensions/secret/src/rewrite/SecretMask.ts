const SECRET_REFERENCE_SEGMENT = /(\$\{SECRET:[^{}]+\})/gu;

export function maskSecretValues(
    text: string,
    environment: Readonly<Record<string, string>>,
): string {
    const byValue = new Map<string, string>();
    for (const [name, value] of Object.entries(environment)
        .filter(([, value]) => value.length > 0)
        .sort(
            ([leftName, left], [rightName, right]) =>
                right.length - left.length || compareNames(leftName, rightName),
        )) {
        if (!byValue.has(value)) byValue.set(value, name);
    }
    if (byValue.size === 0) return text;
    const values = [...byValue.keys()].sort((left, right) => right.length - left.length);
    const pattern = new RegExp(values.map(escapeRegExp).join("|"), "gu");
    return text
        .split(SECRET_REFERENCE_SEGMENT)
        .map((segment) =>
            /^\$\{SECRET:[^{}]+\}$/u.test(segment)
                ? segment
                : segment.replace(
                      pattern,
                      (value) => `\${SECRET:${byValue.get(value)!}}`,
                  ),
        )
        .join("");
}

function compareNames(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
