import type { InstanceName } from "../../type/identity/TypeIdentityInstanceName.js";

export type ControlTarget =
    | {
          type: "controller";
      }
    | {
          instanceName: InstanceName;
          type: "instance";
      };
