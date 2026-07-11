import { WorkspaceProvider } from "./state/workspaceStore";
import { IndexDataProvider } from "./state/indexData";
import { ScanControllerProvider } from "./state/scanController";
import { WorkspaceShell } from "./components/WorkspaceShell";

export function App() {
  return (
    <WorkspaceProvider>
      <IndexDataProvider>
        <ScanControllerProvider>
          <WorkspaceShell />
        </ScanControllerProvider>
      </IndexDataProvider>
    </WorkspaceProvider>
  );
}
