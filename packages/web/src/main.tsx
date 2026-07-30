import { createRoot } from "react-dom/client";
import { createWebClients } from "./client/WebClients.js";
import { WebStore } from "./state/WebStore.js";
import { App } from "./views/App.js";
import "./styles.css";
createRoot(document.getElementById("root")!).render(<App store={new WebStore(createWebClients())} />);
