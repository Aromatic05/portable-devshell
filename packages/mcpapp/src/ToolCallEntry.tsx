import { createRoot } from "react-dom/client";
import { ToolCallInline } from "./ToolCallInline.js";
import "./Style.css";

const root = document.getElementById("root");
if (root === null) throw new Error("ToolCall root is missing.");
createRoot(root).render(<ToolCallInline />);
