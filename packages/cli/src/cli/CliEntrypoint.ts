import { pathToFileURL } from "node:url";

export function isCliEntrypoint(moduleUrl: string, argvPath: string | undefined): boolean {
    return argvPath !== undefined && moduleUrl === pathToFileURL(argvPath).href;
}
