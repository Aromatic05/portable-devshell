import { applyEventRecord } from "./TuiStoreReducerEvent.js";
import { compareToolCallRecord, dedupeLogs, mergeLogEntry, pruneByInstanceNames, pruneByInstances, selectInstanceAfterListReplace, withDerivedState } from "./TuiStoreReducerSupport.js";
import type { TuiAppAction, TuiAppState } from "./TuiStoreModel.js";

export function reduceTuiStoreReducerInstance(state: TuiAppState, action: TuiAppAction): TuiAppState | undefined {
    switch (action.type) {
        case "instance.replaceList":
            return withDerivedState(selectInstanceAfterListReplace({
                ...state,
                approvalsByInstance: pruneByInstances(state.approvalsByInstance, action.instances),
                instances: [...action.instances],
                lastSeqByInstance: pruneByInstanceNames(state.lastSeqByInstance, action.instances),
                lastStatusChangeAtByInstance: pruneByInstanceNames(state.lastStatusChangeAtByInstance, action.instances),
                logsByInstance: pruneByInstances(state.logsByInstance, action.instances),
                snapshotsByInstance: pruneByInstances(state.snapshotsByInstance, action.instances),
                todoByInstance: pruneByInstances(state.todoByInstance, action.instances),
                toolCallsByInstance: pruneByInstances(state.toolCallsByInstance, action.instances)
            }));
        case "log.append": {
            const current = state.logsByInstance[action.entry.instance] ?? [];
            return withDerivedState({
                ...state,
                logsByInstance: {
                    ...state.logsByInstance,
                    [action.entry.instance]: mergeLogEntry(current, action.entry)
                }
            });
        }
        case "log.replace":
            return withDerivedState({
                ...state,
                logsByInstance: {
                    ...state.logsByInstance,
                    [action.instance]: dedupeLogs(action.logs)
                }
            });
        case "log.clearBuffer":
            return withDerivedState({
                ...state,
                logsByInstance: {}
            });
        case "snapshot.replace":
            return withDerivedState({
                ...state,
                lastSeqByInstance: {
                    ...state.lastSeqByInstance,
                    [action.snapshot.name]: action.snapshot.lastSeq
                },
                snapshotsByInstance: {
                    ...state.snapshotsByInstance,
                    [action.snapshot.name]: action.snapshot
                }
            });
        case "todo.replace":
            return {
                ...state,
                todoByInstance: {
                    ...state.todoByInstance,
                    [action.instance]: action.todo
                }
            };
        case "toolCall.replace":
            return withDerivedState({
                ...state,
                toolCallsByInstance: {
                    ...state.toolCallsByInstance,
                    [action.instance]: [...action.records].sort(compareToolCallRecord)
                }
            });
        case "instance.setLastSeq":
            if ((state.lastSeqByInstance[action.instance] ?? 0) >= action.seq) {
                return state;
            }

            return {
                ...state,
                lastSeqByInstance: {
                    ...state.lastSeqByInstance,
                    [action.instance]: action.seq
                }
            };
        case "event.append": {
            const rawEvents = [...state.rawEvents, action.rawEvent];
            const maxEvents = action.maxEvents ?? 100;
            const nextState = {
                ...state,
                lastSeqByInstance:
                    (state.lastSeqByInstance[action.rawEvent.instance] ?? 0) >= action.rawEvent.seq
                        ? state.lastSeqByInstance
                        : {
                              ...state.lastSeqByInstance,
                              [action.rawEvent.instance]: action.rawEvent.seq
                          },
                rawEvents: rawEvents.slice(Math.max(0, rawEvents.length - maxEvents))
            };
            return withDerivedState(applyEventRecord(nextState, action.rawEvent));
        }
    }
}
