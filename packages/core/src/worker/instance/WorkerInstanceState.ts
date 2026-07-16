import type { JsonValue, ReverseInstanceStatus } from "@portable-devshell/shared";

import { InstanceEventBuffer, type InstanceEventInput, type InstanceEventStreamGap, type InstanceEventStreamSlice } from "../../instance/event/InstanceEventBuffer.js";
import { InstanceStateMachine, type InstanceStateUpdate } from "../../instance/state/InstanceStateMachine.js";
import type { InstanceSnapshot } from "../../instance/state/InstanceStateSnapshot.js";
import type { ResolvedWorkerInstanceConfig } from "./WorkerInstanceConfig.js";
import {
    createConnectionChangedEventData,
    createReadyChangedEventData,
    createStatusChangedEventData
} from "./WorkerInstanceEvent.js";
import { normalizeLifecycleStatus } from "./WorkerInstanceStatus.js";

interface WorkerInstanceStateOptions {
    config: ResolvedWorkerInstanceConfig;
    eventBuffer: InstanceEventBuffer;
    stateMachine: InstanceStateMachine;
}

export class WorkerInstanceState {
    readonly #config: ResolvedWorkerInstanceConfig;
    readonly #eventBuffer: InstanceEventBuffer;
    readonly #stateMachine: InstanceStateMachine;

    constructor(options: WorkerInstanceStateOptions) {
        this.#config = options.config;
        this.#eventBuffer = options.eventBuffer;
        this.#stateMachine = options.stateMachine;
    }

    snapshot(reverse?: ReverseInstanceStatus): InstanceSnapshot {
        return {
            ...this.#stateMachine.snapshot(),
            effectiveSecurityMode: this.#config.effectiveSecurityMode,
            ...(reverse === undefined ? {} : { reverse })
        };
    }

    subscribe(fromSeq = 1): InstanceEventStreamGap | InstanceEventStreamSlice {
        return this.#eventBuffer.readFrom(fromSeq);
    }

    async appendEvent(type: InstanceEventInput["type"], data?: JsonValue) {
        const event = await this.#eventBuffer.append({
            at: new Date().toISOString(),
            data,
            type
        });
        this.#stateMachine.apply({ lastSeq: event.seq });
        return event;
    }

    async apply(update: InstanceStateUpdate, reverse?: ReverseInstanceStatus): Promise<InstanceSnapshot> {
        const previous = this.snapshot(reverse);
        this.#stateMachine.apply(update);
        const next = this.snapshot(reverse);

        if (
            previous.daemonState !== next.daemonState ||
            normalizeLifecycleStatus(previous.status) !== normalizeLifecycleStatus(next.status)
        ) {
            await this.appendEvent("instance.statusChanged", createStatusChangedEventData(previous, next));
        }

        if (previous.connectionState !== next.connectionState) {
            await this.appendEvent("instance.connectionChanged", createConnectionChangedEventData(previous, next));
        }

        if (previous.ready !== next.ready) {
            await this.appendEvent("instance.readyChanged", createReadyChangedEventData(previous, next));
        }

        return this.snapshot(reverse);
    }
}
