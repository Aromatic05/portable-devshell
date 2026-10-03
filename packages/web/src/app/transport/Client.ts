import {
    type Channel,
} from "@portable-devshell/shared";

import { WebDomainSession } from "../domain/Session.js";
import { connectBrowserWebChannel } from "./Socket.js";

export type WebChannelConnector = (signal?: AbortSignal) => Promise<Channel>;

export function createWebDomainSession(
    connectChannel: WebChannelConnector = connectBrowserWebChannel,
): WebDomainSession {
    return new WebDomainSession({
        connectChannel,
    });
}
