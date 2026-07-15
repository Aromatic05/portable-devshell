import { ProtocolControlStream, type ProtocolControlStreamMessage } from "@portable-devshell/shared";

export type TuiControlStreamMessage = ProtocolControlStreamMessage;
export class TuiControlStream extends ProtocolControlStream {}
