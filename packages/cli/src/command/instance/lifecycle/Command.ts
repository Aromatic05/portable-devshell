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
            const instances = await context.clients.instance.list();
            context.writeRecords(instances, renderInstanceList(instances));
            return true;
        }
        case "instance.delete":
            context.writeJson(
                await context.clients.instance.delete(command.instance),
            );
            return true;
        case "instance.enable":
            context.writeJson(
                await context.clients.instance.enable(command.instance),
            );
            return true;
        case "instance.disable":
            context.writeJson(
                await context.clients.instance.disable(command.instance),
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
                await context.clients.runtime.snapshot(command.instance)
            ).snapshot;
            context.writeValue(snapshot, renderInstanceSnapshot(snapshot));
            return true;
        }
        case "instance.start": {
            const snapshot = await context.clients.runtime.start(
                command.instance,
                {
                    input: context.stdin,
                    output: context.stderr,
                },
            );
            context.writeValue(snapshot, renderInstanceSnapshot(snapshot));
            return true;
        }
        case "instance.stop": {
            const snapshot = await context.clients.runtime.stop(
                command.instance,
            );
            context.writeValue(snapshot, renderInstanceSnapshot(snapshot));
            return true;
        }
        default:
            return false;
    }
}
