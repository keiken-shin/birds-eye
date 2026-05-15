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
    <main className="relative block min-h-screen overflow-x-hidden bg-[#050607] bg-[radial-gradient(circle,rgba(255,255,255,0.13)_1px,transparent_1.3px)] bg-[length:24px_24px] text-[#f4f1ea] before:pointer-events-none before:absolute before:bottom-0 before:right-0 before:h-[40rem] before:w-[40rem] before:bg-[radial-gradient(circle_at_82%_82%,rgba(244,241,234,0.10),transparent_22rem)]">
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
      <section className="relative z-[1] mx-auto max-w-[1440px] min-w-0 px-[42px] pb-[118px] max-sm:px-4 max-sm:pb-28">
        <header className="mb-[18px] grid gap-2 border-t border-[#f4f1ea]/20 pt-5" id="workspace">
          <p className="m-0 text-[13px] font-bold uppercase text-[#00d0c4]">Workspace / storage intelligence</p>
          <h2 className="max-w-[860px] text-[clamp(28px,3vw,46px)] font-black uppercase leading-[0.95] text-[#f4f1ea]">Indexed terrain and cleanup surfaces</h2>
          <span className="max-w-[760px] text-sm leading-normal text-[#9a9a94]">Treemap, search, duplicate candidates, and saved local indexes remain live below the launch interface.</span>
        </header>
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
