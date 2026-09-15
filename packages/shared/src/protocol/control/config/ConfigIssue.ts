export type ConfigPathSegment = number | string;
export type ConfigIssuePhase = "normalize" | "parse" | "semantic";

export interface ConfigIssue {
    code: string;
    message: string;
    path: readonly ConfigPathSegment[];
    phase: ConfigIssuePhase;
}

export function formatConfigPath(path: readonly ConfigPathSegment[]): string {
    let result = "";

    for (const segment of path) {
        if (typeof segment === "number") {
            result += `[${segment}]`;
        } else {
            result += result.length === 0 ? segment : `.${segment}`;
        }
    }

    return result;
}

export class ConfigInputError extends Error {
    readonly issue: ConfigIssue;

    constructor(issue: ConfigIssue) {
        const fieldPath = formatConfigPath(issue.path);
        super(fieldPath.length === 0 ? issue.message : `${fieldPath} ${issue.message}`);
        this.name = "ConfigInputError";
        this.issue = issue;
    }
}

export function configInputError(
    phase: ConfigIssuePhase,
    path: readonly ConfigPathSegment[],
    code: string,
    message: string
): ConfigInputError {
    return new ConfigInputError({ code, message, path, phase });
}
