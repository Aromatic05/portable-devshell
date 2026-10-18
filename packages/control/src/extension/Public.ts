// In-process Extension adapters used by Control composition and route hosts.
export { createCliRouteModule } from "./api/point/cli/Endpoint.js";
export { CliExtensionCommandService } from "./api/point/cli/command/Service.js";
export { ControlExtensionRouteService } from "./api/point/control/Dispatch.js";
export {
    TuiExtensionPageService,
    createTuiPageRouteModule,
} from "./api/point/tui/Service.js";
export { createExtensionRouteModule } from "./manager/Endpoint.js";
