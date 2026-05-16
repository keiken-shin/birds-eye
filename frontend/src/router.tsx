import { createHashRouter } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { HomePage } from "./pages/HomePage";
import { WorkspacePage } from "./pages/WorkspacePage";
import { LibraryPage } from "./pages/LibraryPage";
import { ScanPage } from "./pages/ScanPage";

export const router = createHashRouter([
  {
    element: <AppShell />,
    children: [
      { index: true, element: <HomePage /> },
      { path: "workspace", element: <WorkspacePage /> },
      { path: "library", element: <LibraryPage /> },
      { path: "scan", element: <ScanPage /> },
      { path: "scan/:id", element: <ScanPage /> },
    ],
  },
]);
