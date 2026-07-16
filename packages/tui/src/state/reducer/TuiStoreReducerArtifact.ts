import type { TuiAppAction, TuiAppState } from "./TuiStoreModel.js";

export function reduceTuiStoreReducerArtifact(state: TuiAppState, action: TuiAppAction): TuiAppState | undefined {
    switch (action.type) {
        case "artifact.share.replace":
            return {
                ...state,
                artifactShares: [...action.shares].sort((left, right) => right.expiresAtMs - left.expiresAtMs)
            };
        case "artifact.share.upsert":
            return {
                ...state,
                artifactShares: [
                    action.share,
                    ...state.artifactShares.filter((share) => share.shareId !== action.share.shareId)
                ].sort((left, right) => right.expiresAtMs - left.expiresAtMs)
            };
        case "artifact.transfer.replace":
            return {
                ...state,
                artifactTransfers: [...action.transfers].sort((left, right) => right.createdAt.localeCompare(left.createdAt))
            };
        case "artifact.transfer.upsert":
            return {
                ...state,
                artifactTransfers: [
                    action.transfer,
                    ...state.artifactTransfers.filter((transfer) => transfer.transferId !== action.transfer.transferId)
                ].sort((left, right) => right.createdAt.localeCompare(left.createdAt))
            };
    }
}
