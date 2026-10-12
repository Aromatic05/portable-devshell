import { createRoot } from "react-dom/client";
import { AppView } from "./App.js";
import "./Style.css";

const root = document.getElementById("root");
if (root === null) throw new Error("MCP App root is missing.");
createRoot(root).render(<AppView view={document.documentElement.dataset.mcpappView === "interaction" ? "interaction" : "workspace"} />);
