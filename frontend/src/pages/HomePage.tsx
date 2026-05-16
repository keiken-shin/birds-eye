import { useCallback } from "react";
import { useScanContext } from "../context/ScanContext";
import { LandingPage } from "../components/LandingPage";
import { deleteNativeIndex } from "../nativeClient";
import type { NativeIndexEntry } from "../nativeClient";

export function HomePage() {
  const {
    scan,
    runtimeMessage,
    nativeRuntime,
    savedIndexes,
    fileInputRef,
    openFolderPicker,
    currentIndexPath,
    refreshSavedIndexes,
    handleFiles: handleFilesBase,
    pauseScan,
    resumeScan,
    cancelScan,
    clearScan: clearScanBase,
  } = useScanContext();

  const handleFiles = useCallback(
    (fileList: FileList | null) => {
      handleFilesBase(fileList);
    },
    [handleFilesBase]
  );

  const clearScan = useCallback(() => {
    clearScanBase();
  }, [clearScanBase]);

  async function removeSavedIndex(entry: NativeIndexEntry) {
    await deleteNativeIndex(entry.index_path);
    if (currentIndexPath === entry.index_path) clearScan();
    await refreshSavedIndexes();
  }

  return (
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
  );
}
