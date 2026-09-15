import type { CliParsedCommand } from "../../Parse.js";
import type { CliDispatchContext } from "../../Dispatch.js";
export async function executeOverviewCommand(command: CliParsedCommand, context: CliDispatchContext): Promise<boolean> {
    if(command.kind!=="overview") return false;
    context.writeJson(await context.clients.overview.get());
    return true;
}
