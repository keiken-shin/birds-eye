import { useCallback, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { deleteNativeIndex } from "./nativeClient";
import type { NativeIndexEntry } from "./nativeClient";

import { useNativeRuntime } from "./hooks/useNativeRuntime";
import { useSavedIndexes } from "./hooks/useSavedIndexes";
import { useScan } from "./hooks/useScan";
import { useSearch } from "./hooks/useSearch";
import { useDuplicates } from "./hooks/useDuplicates";

import { BottomCommandRail, LandingPage, StorageReadout } from "./components/LandingPage";
import { MetricGrid } from "./components/MetricGrid";
import { FilterBar } from "./components/FilterBar";
import { AnalysisSection } from "./components/AnalysisSection";
import { FoldersTable } from "./components/FoldersTable";
import { SearchPanel } from "./components/SearchPanel";
import { DetailGrid } from "./components/DetailGrid";
import { DuplicatesSection } from "./components/DuplicatesSection";
import { IndexesSection } from "./components/IndexesSection";

import "./styles.css";

function App() {
  const { nativeRuntime, runtimeMessage, setRuntimeMessage } = useNativeRuntime();
  const { savedIndexes, refreshSavedIndexes } = useSavedIndexes({ nativeRuntime, setRuntimeMessage });
  const {
    scan,
    filter, setFilter,
    focusedFolder, setFocusedFolder,
    sortedFolders, filteredFolders,
    currentIndexPath,
    fileInputRef,
    openFolderPicker,
    handleFiles: handleFilesBase,
    pauseScan, resumeScan, cancelScan,
    clearScan: clearScanBase,
    openSavedIndex,
    rescanSavedIndex,
  } = useScan({ nativeRuntime, setRuntimeMessage, refreshSavedIndexes });
  const { searchQuery, setSearchQuery, searchResults } = useSearch({
    currentIndexPath,
    nativeRuntime,
    largestFiles: scan.largestFiles,
    setRuntimeMessage,
  });
  const { duplicateFiles, selectedDuplicateGroup, selectDuplicateCandidate, clearDuplicates } =
    useDuplicates({ currentIndexPath, setRuntimeMessage });

  // Clear search query and duplicate selection when currentIndexPath is cleared
  // (happens when a new scan starts or results are cleared)
  useEffect(() => {
    if (currentIndexPath === null) {
      setSearchQuery("");
      clearDuplicates();
    }
  }, [currentIndexPath, setSearchQuery, clearDuplicates]);

  // Wrap clearScan to also reset search and duplicate state immediately
  const clearScan = useCallback(() => {
    setSearchQuery("");
    clearDuplicates();
    clearScanBase();
  }, [clearScanBase, setSearchQuery, clearDuplicates]);

  // In browser-mode currentIndexPath stays null, so the useEffect below never
  // re-fires between scans. Wrap handleFiles to clear stale state explicitly.
  const handleFiles = useCallback((fileList: FileList | null) => {
    setSearchQuery("");
    clearDuplicates();
    handleFilesBase(fileList);
  }, [handleFilesBase, setSearchQuery, clearDuplicates]);

  async function removeSavedIndex(entry: NativeIndexEntry) {
    await deleteNativeIndex(entry.index_path);
    if (currentIndexPath === entry.index_path) {
      clearScan();
    }
    await refreshSavedIndexes();
  }

  return (
    <main className="app-shell">
      <LandingPage
        scan={scan}
        runtimeMessage={runtimeMessage}
        nativeRuntime={nativeRuntime}
        savedIndexes={savedIndexes}
        fileInputRef={fileInputRef}
        openFolderPicker={openFolderPicker}
        handleFiles={handleFiles}
        pauseScan={pauseScan}
        resumeScan={resumeScan}
        cancelScan={cancelScan}
        clearScan={clearScan}
      />
      <section className="workspace">
        <StorageReadout scan={scan} />
        <MetricGrid scan={scan} />
        <FilterBar filter={filter} setFilter={setFilter} />
        <AnalysisSection
          filteredFolders={filteredFolders}
          focusedFolder={focusedFolder}
          setFocusedFolder={setFocusedFolder}
          scan={scan}
        />
        <FoldersTable sortedFolders={sortedFolders} />
        <SearchPanel
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          searchResults={searchResults}
        />
        <DetailGrid largestFiles={scan.largestFiles} extensions={scan.extensions} />
        <DuplicatesSection
          duplicateCandidates={scan.duplicateCandidates}
          selectedDuplicateGroup={selectedDuplicateGroup}
          selectDuplicateCandidate={selectDuplicateCandidate}
          duplicateFiles={duplicateFiles}
        />
        <IndexesSection
          nativeRuntime={nativeRuntime}
          savedIndexes={savedIndexes}
          openSavedIndex={openSavedIndex}
          rescanSavedIndex={rescanSavedIndex}
          removeSavedIndex={removeSavedIndex}
        />
      </section>
      <BottomCommandRail openFolderPicker={openFolderPicker} />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
