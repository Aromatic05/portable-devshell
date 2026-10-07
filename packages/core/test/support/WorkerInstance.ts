import {
    runtimeErrorCodes,
    type Channel,
    type InstanceName,
    type JsonValue,
} from "@portable-devshell/shared";
import { join } from "node:path";

import { createAuditRuntime } from "../../src/audit/index.ts";
import type { AuditRuntime } from "../../src/audit/Api.ts";
import type { WorkerToolDefinition } from "../../src/instance/Api.ts";
import { WorkerBinary } from "../../src/instance/runtime/Binary.ts";
import { WorkerCommandClient, type WorkerRuntime } from "../../src/instance/runtime/execution/Command.ts";
import { LocalExecution } from "../../src/instance/runtime/execution/provider/Local.ts";
import { WorkerInstance } from "../../src/instance/runtime/index.ts";
import { resolveWorkerInstanceConfig } from "../../src/instance/runtime/provision/Config.ts";
import { LocalInstall } from "../../src/instance/runtime/provision/install/provider/Local.ts";
import { InstanceEventBuffer } from "../../src/instance/runtime/supervision/Event.ts";
import { InstanceStateMachine } from "../../src/instance/runtime/supervision/State.ts";
import { TransportConnection } from "../../src/instance/transport/endpoint/Connection.ts";
import { TransportFactory } from "../../src/instance/transport/endpoint/Factory.ts";
import { WorkerProtocolClient } from "../../src/instance/transport/packet/Client.ts";
import { createToolCallExecutionRuntime } from "../../src/toolcall/index.ts";
import type { ToolCallExecutionRuntime } from "../../src/toolcall/Api.ts";
import type { WorkerCommandResult } from "../../src/instance/runtime/execution/Command.ts";
import type { WorkerCommandName } from "../../src/instance/runtime/Binary.ts";
import type { WorkerCommandOptions, WorkerChannelOptions } from "../../src/instance/runtime/execution/Command.ts";

export interface TestWorkerTransport {
    connectWorkerChannel(options: WorkerChannelOptions): Promise<Channel>;
    installWorker(): Promise<void>;
    runWorkerCommand(
        command: WorkerCommandName,
        options: WorkerCommandOptions,
    ): Promise<WorkerCommandResult>;
}

export interface TestWorkerInstanceOptions {
    env?: NodeJS.ProcessEnv;
    homeDirectory: string;
    name: InstanceName;
    transport?: TestWorkerTransport;
    workerBinaryPath?: string;
}

export interface TestWorkerToolRuntime {
    audit: AuditRuntime;
    execution: ToolCallExecutionRuntime;
}

export interface TestWorkerInstance extends WorkerInstance {
    readWorkerTools(): Promise<WorkerToolDefinition[]>;
}

export function createTestWorkerInstance(
    options: TestWorkerInstanceOptions,
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
    const events = new InstanceEventBuffer(options.name, 1024);
    const protocolClient = new WorkerProtocolClient(endpoint, workerHost);
    const worker = new WorkerInstance({
        admission: { active: () => true, enabled: () => true },
        commandClient: new WorkerCommandClient(runtime, options.name, options.env),
        config,
        endpoint,
        events,
        onReadyChanged: async () => undefined,
        protocolClient,
        stateMachine: new InstanceStateMachine(options.name),
        transportConnection: connection,
    });
    return Object.assign(worker, {
        readWorkerTools: async () => (await protocolClient.listTools()).tools,
    });
}

export function createTestWorkerToolRuntime(options: {
    homeDirectory: string;
    instanceName: InstanceName;
    worker: TestWorkerInstance;
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
                await options.worker.supervision.state.appendEvent(type, data),
            assertReady: () => {
                if (options.worker.supervision.snapshot().ready) return;
                throw Object.assign(
                    new Error(`Instance ${options.instanceName} is not ready.`),
                    { code: runtimeErrorCodes.instanceNotReady },
                );
            },
            audit: audit.api,
            endpoint: options.worker.supervision.endpoint,
            instanceName: options.instanceName,
            prepareWorkspace: (workspace) =>
                options.worker.execution.environment.prepareWorkspace(workspace),
            readTools: async () => await options.worker.readWorkerTools(),
            releaseWorkspace: async (workspace) =>
                await options.worker.execution.environment.releaseAlerts(
                    workspace,
                ),
        }),
    };
}

function createRuntime(options: TestWorkerInstanceOptions): WorkerRuntime {
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
