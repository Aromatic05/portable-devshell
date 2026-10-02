// Interaction bounded context public surface, split into clear subdomains:
//
//   - context/       MCP Context records (control, global)
//   - message/       per-instance Context messages
//   - conversation/  Conversation entries + preferences
//
// OAuth approval remains owned by the MCP bounded context and Terminal
// sessions by the instance terminal bounded context, so neither is present here.

export * from "./context/Model.js";
export * from "./context/Contract.js";
export * from "./context/Error.js";
export * from "./context/Transport.js";
export * from "./context/ViewModel.js";

export * from "./message/Model.js";
export * from "./message/Contract.js";
export * from "./message/Transport.js";
export * from "./message/ViewModel.js";

export * from "./conversation/Model.js";
export * from "./conversation/Contract.js";
export * from "./conversation/Transport.js";
export * from "./conversation/ViewModel.js";
