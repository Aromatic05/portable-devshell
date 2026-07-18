import { homedir } from "node:os";
import { win32 } from "node:path";

export function resolveInstallHome(
    environment = process.env,
    platform = process.platform,
    systemHome = homedir()
) {
    const configured = platform === "win32"
        ? resolveWindowsHome(environment)
        : firstNonEmpty(environment.HOME);

    if (configured !== undefined) {
        return configured;
    }
    if (systemHome.length === 0) {
        throw new Error("the current user home directory is unavailable");
    }
    return systemHome;
}

function resolveWindowsHome(environment) {
    const userProfile = firstNonEmpty(environment.USERPROFILE);
    if (userProfile !== undefined) {
        return userProfile;
    }

    const homeDrive = firstNonEmpty(environment.HOMEDRIVE);
    const homePath = firstNonEmpty(environment.HOMEPATH);
    if (homeDrive !== undefined && homePath !== undefined) {
        return win32.resolve(`${homeDrive}\\`, homePath);
    }

    return firstNonEmpty(environment.HOME);
}

function firstNonEmpty(...values) {
    return values.find((value) => typeof value === "string" && value.length > 0);
}
