import type { PortClient } from "@portable-devshell/shared";

import { Worker } from "../worker/index.js";

export class ReverseChannel extends Worker<PortClient> {}
