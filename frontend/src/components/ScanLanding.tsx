import React from "react";
import { Loader2 } from "lucide-react";

interface ScanLandingProps {
  onComplete: () => void;
  progress: number;
}

export const ScanLanding: React.FC<ScanLandingProps> = ({ onComplete, progress }) => {
  return (
    <div className="fixed inset-0 bg-[#0a0a0f] flex flex-col items-center justify-center z-[100]">
      <Loader2 className="w-16 h-16 text-indigo-500 animate-spin mb-6" />
      <div className="text-indigo-400 font-mono text-sm tracking-widest uppercase">
        Scanning Filesystem
      </div>
      <div className="mt-4 w-64 bg-slate-800 rounded-full h-2 relative overflow-hidden">
        <div 
          className="bg-indigo-500 h-2 rounded-full transition-all duration-300 absolute left-0 top-0"
          style={{ width: `${progress}%` }}
        ></div>
      </div>
      {progress >= 100 && (
        <button 
          onClick={onComplete}
          className="mt-6 px-6 py-2 bg-indigo-500 hover:bg-indigo-600 text-white rounded-md transition-colors"
        >
          Enter Nexus
        </button>
      )}
    </div>
  );
};
