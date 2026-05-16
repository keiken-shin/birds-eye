import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { ScanProvider } from "./context/ScanContext";
import { router } from "./router";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <ScanProvider>
    <RouterProvider router={router} />
  </ScanProvider>
);
