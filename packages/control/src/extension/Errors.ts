import {
    controlErrorCodes,
    createRemoteError,
    toRemoteErrorBody,
} from "@portable-devshell/shared";

export class ExtensionCandidatePublicationError extends Error {
    constructor(generation: string, cause: unknown) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        super(
            `Extension generation ${generation} failed before publication: ${detail}`,
            { cause },
        );
        this.name = "ExtensionCandidatePublicationError";
    }
}

export function extensionNotFound(id: string): Error {
    return createRemoteError({
        code: controlErrorCodes.extensionNotFound,
        details: { extensionId: id },
        message: `Extension ${id} is not installed.`,
        retryable: false,
    });
}

export function extensionNotActive(id: string, reason?: string): Error {
    return createRemoteError({
        code: controlErrorCodes.extensionNotActive,
        details: {
            extensionId: id,
            ...(reason === undefined ? {} : { reason }),
        },
        message: `Extension ${id} is not active${reason === undefined ? "." : `: ${reason}.`}`,
        retryable: false,
    });
}

export function extensionInvalid(id: string, reason: string): Error {
    return createRemoteError({
        code: controlErrorCodes.extensionInvalid,
        details: { extensionId: id, reason },
        message: `Extension ${id} ${reason}.`,
        retryable: false,
    });
}

export function extensionFailure(
    id: string,
    generation: string | undefined,
    error: unknown,
): Error {
    if (toRemoteErrorBody(error) !== undefined) return error as Error;
    return createRemoteError({
        code: controlErrorCodes.extensionFailed,
        cause: error,
        details: {
            extensionId: id,
            ...(generation === undefined ? {} : { generation }),
        },
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
    });
}
