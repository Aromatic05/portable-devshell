import type { InstanceName } from "../types/InstanceName.js";

export type ControlTarget =
    | {
          type: "controller";
      }
    | {
          instanceName: InstanceName;
          type: "instance";
      };
