import { createRoot } from "react-dom/client";
import "@fontsource-variable/space-grotesk";
import "@fontsource-variable/jetbrains-mono";
import { App } from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(<App />);
