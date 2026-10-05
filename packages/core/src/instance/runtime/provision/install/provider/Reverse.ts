import { TransportConnection } from "../../../../transport/endpoint/Connection.js";
import type {
    WorkerInstanceConfig,
    WorkerInstanceConfigCommon,
} from "../../Config.js";

export class ReverseProvision {
    readonly transportConnection = new TransportConnection();

    createConfig(common: WorkerInstanceConfigCommon): WorkerInstanceConfig {
        return {
            ...common,
            managementMode: "selfManaged",
            transportConnection: this.transportConnection,
        };
    }
}
