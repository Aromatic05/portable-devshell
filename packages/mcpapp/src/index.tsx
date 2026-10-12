import { createRoot } from "react-dom/client";
import { AppView } from "./App.js";
import "./Style.css";

const root = document.getElementById("root");
if (root === null) throw new Error("MCP App root is missing.");
const kind = document.documentElement.dataset.mcpappView;
createRoot(root).render(<AppView view={kind === "interaction" || kind === "toolcall" ? kind : "workspace"} />);
