import type { CliParsedCommand } from "../../Parse.js";
import type { CliDispatchContext } from "../../Dispatch.js";
import { renderInstanceList, renderInstanceSnapshot } from "./Render.js";
import { renderReverseDeviceCode, renderReverseTokenRevocation, renderReverseTokenRotation } from "./Reverse.js";

export async function executeInstanceLifecycle(command: CliParsedCommand, context: CliDispatchContext): Promise<boolean> {
    switch(command.kind){
        case "instance.list": context.stdout.write(renderInstanceList(await context.clients.instance.list())); return true;
        case "instance.delete": context.writeJson(await context.clients.instance.delete(command.instance)); return true;
        case "instance.enable": context.writeJson(await context.clients.instance.enable(command.instance)); return true;
        case "instance.disable": context.writeJson(await context.clients.instance.disable(command.instance)); return true;
        case "instance.deviceCode": context.stdout.write(renderReverseDeviceCode(await context.clients.reverse.createCode(command.instance))); return true;
        case "instance.rotateToken": context.stdout.write(renderReverseTokenRotation(await context.clients.reverse.rotateToken(command.instance))); return true;
        case "instance.revokeToken": context.stdout.write(renderReverseTokenRevocation(await context.clients.reverse.revokeToken(command.instance))); return true;
        case "instance.status": context.stdout.write(renderInstanceSnapshot((await context.clients.runtime.snapshot(command.instance)).snapshot)); return true;
        case "instance.start": context.stdout.write(renderInstanceSnapshot(await context.clients.runtime.start(command.instance,{input:context.stdin,output:context.stderr}))); return true;
        case "instance.stop": context.stdout.write(renderInstanceSnapshot(await context.clients.runtime.stop(command.instance))); return true;
        default:return false;
    }
}
