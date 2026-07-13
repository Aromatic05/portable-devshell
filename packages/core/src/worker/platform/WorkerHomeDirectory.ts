import { homedir } from "node:os";

export function resolveWorkerHomeDirectory(environment: NodeJS.ProcessEnv = process.env): string {
    const configured = environment.HOME ?? environment.USERPROFILE;
    if (configured !== undefined && configured.length > 0) {
        return configured;
    }

    const systemHome = homedir();
    if (systemHome.length === 0) {
        throw new Error("the current user home directory is unavailable");
    }
    return systemHome;
}
