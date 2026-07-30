import { CONTROL_WEB_BASE_PATH } from "@portable-devshell/shared/browser";

const webSegment = CONTROL_WEB_BASE_PATH.slice(1);

export function webRoutePath(pathname: string, suffix: "/rpc" | "/session"): string {
    const segments = pathname.split("/");
    const webIndex = segments.lastIndexOf(webSegment);
    if (webIndex < 0) {
        return `${CONTROL_WEB_BASE_PATH}${suffix}`;
    }
    const basePath = segments.slice(0, webIndex + 1).join("/");
    return `${basePath.startsWith("/") ? basePath : `/${basePath}`}${suffix}`;
}
