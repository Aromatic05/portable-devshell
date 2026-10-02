// Artifact bounded-context error codes. Artifact failures are raised by the
// artifact control port and its hosts; the values are the wire codes carried in
// RemoteErrorBody.code.

export const artifactErrorCodes = {
    contentUnavailable: "artifact.contentUnavailable",
    directoryUnsafe: "artifact.directoryUnsafe",
    hostPathDenied: "artifact.hostPathDenied",
    imageTooLarge: "artifact.imageTooLarge",
    imageUnsupported: "artifact.imageUnsupported",
    payloadInvalid: "artifact.payloadInvalid",
    shareExhausted: "artifact.shareExhausted",
    shareExpired: "artifact.shareExpired",
    shareNotFound: "artifact.shareNotFound",
    shareRevoked: "artifact.shareRevoked",
    transferInterrupted: "artifact.transferInterrupted",
    transferNotFound: "artifact.transferNotFound",
    transferStateConflict: "artifact.transferStateConflict",
} as const;

export type ArtifactErrorCode =
    (typeof artifactErrorCodes)[keyof typeof artifactErrorCodes];
