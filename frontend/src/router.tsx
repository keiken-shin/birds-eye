import { createHashRouter } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { HomePage } from "./pages/HomePage";
import { WorkspacePage } from "./pages/WorkspacePage";
import { LibraryPage } from "./pages/LibraryPage";
import { ScanPage } from "./pages/ScanPage";
import { CleanupPage } from "./pages/CleanupPage";
import { DiscoveriesPage } from "./pages/DiscoveriesPage";
import { RecentlyCleanedPage } from "./pages/RecentlyCleanedPage";
import { SavedViewsPage } from "./pages/SavedViewsPage";

export const router = createHashRouter([
  {
    element: <AppShell />,
    children: [
      { index: true, element: <HomePage /> },
      { path: "workspace", element: <WorkspacePage /> },
      { path: "library", element: <LibraryPage /> },
      { path: "scan", element: <ScanPage /> },
      { path: "scan/:id", element: <ScanPage /> },
      { path: "cleanup", element: <CleanupPage /> },
      { path: "discoveries", element: <DiscoveriesPage /> },
      { path: "recently-cleaned", element: <RecentlyCleanedPage /> },
      { path: "saved-views", element: <SavedViewsPage /> },
    ],
  },
]);
