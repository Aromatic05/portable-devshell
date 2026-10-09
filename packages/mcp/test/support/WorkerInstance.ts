import {
    runtimeErrorCodes,
    type Channel,
    type Endpoint,
    type InstanceName,
    type InstanceSnapshot,
    type JsonValue,
    type ToolDefinition,
} from "@portable-devshell/shared";
import { join } from "node:path";

import { createAuditRuntime } from "../../../core/src/audit/index.ts";
import { createToolCallExecutionRuntime } from "../../../core/src/toolcall/index.ts";
import { InstanceEventBuffer } from "../../../core/src/instance/runtime/supervision/Event.ts";
import {
    WorkerCommandClient,
    type WorkerCommandResult,
    type WorkerRuntime,
    type WorkerChannelOptions,
    type WorkerCommandOptions,
    type WorkerCommandName,
} from "../../../core/src/instance/runtime/execution/Command.ts";
import { WorkerBinary } from "../../../core/src/instance/runtime/Binary.ts";
import { LocalExecution } from "../../../core/src/instance/runtime/execution/provider/Local.ts";
import { LocalInstall } from "../../../core/src/instance/runtime/provision/install/provider/Local.ts";
import { resolveWorkerInstanceConfig } from "../../../core/src/instance/runtime/provision/Config.ts";
import { WorkerInstance } from "../../../core/src/instance/runtime/index.ts";
import { InstanceStateMachine } from "../../../core/src/instance/runtime/supervision/State.ts";
import { WorkerProtocolClient } from "../../../core/src/instance/transport/packet/Client.ts";
import { TransportConnection } from "../../../core/src/instance/transport/endpoint/Connection.ts";
import { TransportFactory } from "../../../core/src/instance/transport/endpoint/Factory.ts";

export interface TestWorkerTransport {
    connectWorkerChannel(options: WorkerChannelOptions): Promise<Channel>;
    installWorker(): Promise<void>;
    runWorkerCommand(
        command: WorkerCommandName,
        options: WorkerCommandOptions,
    ): Promise<WorkerCommandResult>;
}

export interface TestWorkerInstanceFields {
    env?: NodeJS.ProcessEnv;
    homeDirectory: string;
    name: InstanceName;
    transport?: TestWorkerTransport;
    workerBinaryPath?: string;
}

export interface TestWorkerInstance {
    readonly endpoint: Endpoint;
    appendControlEvent(type: string, data?: JsonValue): Promise<void>;
    close(): Promise<void>;
    readTools(): Promise<readonly ToolDefinition[]>;
    snapshot(): InstanceSnapshot;
    start(): Promise<void>;
    stop(): Promise<void>;
}

export interface TestWorkerToolRuntime {
    audit: ReturnType<typeof createAuditRuntime>;
    execution: ReturnType<typeof createToolCallExecutionRuntime>;
}

export function createTestWorkerInstance(
    options: TestWorkerInstanceFields,
): TestWorkerInstance {
    const runtime = createRuntime(options);
    const connection = new TransportConnection(() =>
        runtime.connectChannel({
            env: options.env,
            instanceName: options.name,
        }),
    );
    const config = resolveWorkerInstanceConfig({
        env: options.env,
        homeDirectory: options.homeDirectory,
        name: options.name,
        runtime,
        transportConnection: connection,
    });
    const workerHost = `${options.name}-worker`;
    const endpoint = TransportFactory.createEndpoint(
        connection,
        options.name,
        workerHost,
    );
    const protocolClient = new WorkerProtocolClient(endpoint, workerHost);
    const instance = new WorkerInstance({
        admission: { active: () => true, enabled: () => true },
        commandClient: new WorkerCommandClient(runtime, options.name, options.env),
        config,
        endpoint,
        events: new InstanceEventBuffer(options.name, 1024),
        onReadyChanged: async () => undefined,
        protocolClient,
        stateMachine: new InstanceStateMachine(options.name),
        transportConnection: connection,
    });
    return {
        endpoint,
        appendControlEvent: async (type, data) =>
            await instance.supervision.state.appendEvent(type as never, data),
        close: () => instance.supervision.close(),
        readTools: async () => (await protocolClient.listTools()).tools,
        snapshot: () => instance.supervision.snapshot(),
        start: async () => {
            await instance.supervision.lifecycle.start();
        },
        stop: async () => {
            await instance.supervision.lifecycle.stop();
        },
    };
}

export function createTestWorkerToolRuntime(options: {
    homeDirectory: string;
    instanceName: InstanceName;
    worker: TestWorkerInstance;
    readTools?(): Promise<readonly ToolDefinition[]>;
}): TestWorkerToolRuntime {
    const audit = createAuditRuntime({
        eventBufferSize: 1024,
        filePath: join(options.homeDirectory, "audit.sqlite"),
        instanceName: options.instanceName,
    });
    return {
        audit,
        execution: createToolCallExecutionRuntime({
            appendEvent: async (type, data?: JsonValue) =>
                await options.worker.appendControlEvent(type, data),
            assertReady: () => {
                if (options.worker.snapshot().ready) return;
                throw Object.assign(
                    new Error(`Instance ${options.instanceName} is not ready.`),
                    { code: runtimeErrorCodes.instanceNotReady },
                );
            },
            audit: audit.api,
            endpoint: options.worker.endpoint,
            instanceName: options.instanceName,
            readTools: options.readTools ?? (() => options.worker.readTools()),
            prepareWorkspace: async (workspace) => ({
                projectMemoryAgentFile: `${workspace}/AGENTS.md`,
                projectMemoryDirectory: workspace,
                projectMemoryPresent: false,
                temporaryDirectory: `${workspace}/tmp`,
                workspace,
            }),
            releaseWorkspace: async () => {},
        }),
    };
}

function createRuntime(options: TestWorkerInstanceFields): WorkerRuntime {
    if (options.transport !== undefined) {
        const transport = options.transport;
        return {
            connectChannel: (input) => transport.connectWorkerChannel(input),
            installWorker: () => transport.installWorker(),
            runWorkerCommand: (command, input) =>
                transport.runWorkerCommand(command, input),
        };
    }
    if (options.workerBinaryPath === undefined)
        throw new Error("A test worker transport or binary path is required.");
    return new LocalExecution({
        install: new LocalInstall({
            workerBinary: new WorkerBinary(options.workerBinaryPath),
        }),
    });
}
