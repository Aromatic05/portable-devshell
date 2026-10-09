import type { CliParsedCommand } from "../../Parse.js";
import type { CliDispatchContext } from "../../Dispatch.js";
import { renderInstanceList, renderInstanceSnapshot } from "./Render.js";
import {
    renderReverseDeviceCode,
    renderReverseTokenRevocation,
    renderReverseTokenRotation,
} from "./Reverse.js";

export async function executeInstanceLifecycle(
    command: CliParsedCommand,
    context: CliDispatchContext,
): Promise<boolean> {
    switch (command.kind) {
        case "instance.list": {
            const instances = await context.clients.instance.listInstances();
            // The Control list is configuration only: its snapshots are
            // inactive placeholders. Get live state from each Instance.
            const live = await Promise.all(instances.map(async (instance) =>
                instance.enabled
                    ? {
                        ...instance,
                        snapshot: (await context.clients.runtime(instance.name).snapshot()).snapshot,
                    }
                    : instance,
            ));
            context.writeRecords(live, renderInstanceList(live));
            return true;
        }
        case "instance.delete":
            context.writeJson(
                await context.clients.instance.deleteInstance(command.instance),
            );
            return true;
        case "instance.enable":
            context.writeJson(
                await context.clients.instance.enableInstance(command.instance),
            );
            return true;
        case "instance.disable":
            context.writeJson(
                await context.clients.instance.disableInstance(command.instance),
            );
            return true;
        case "instance.deviceCode": {
            const result = await context.clients.reverse.createCode(
                command.instance,
            );
            context.writeValue(result, renderReverseDeviceCode(result));
            return true;
        }
        case "instance.rotateToken": {
            const result = await context.clients.reverse.rotateToken(
                command.instance,
            );
            context.writeValue(result, renderReverseTokenRotation(result));
            return true;
        }
        case "instance.revokeToken": {
            const result = await context.clients.reverse.revokeToken(
                command.instance,
            );
            context.writeValue(result, renderReverseTokenRevocation(result));
            return true;
        }
        case "instance.status": {
            const snapshot = (
                await context.clients.runtime(command.instance).snapshot()
            ).snapshot;
            context.writeValue(snapshot, renderInstanceSnapshot(snapshot));
            return true;
        }
        case "instance.start": {
            const snapshot = await context.clients.runtime(command.instance).start({
                    input: context.stdin,
                    output: context.stderr,
                });
            context.writeValue(snapshot, renderInstanceSnapshot(snapshot));
            return true;
        }
        case "instance.stop": {
            const snapshot = await context.clients.runtime(command.instance).stop();
            context.writeValue(snapshot, renderInstanceSnapshot(snapshot));
            return true;
        }
        default:
            return false;
    }
}
