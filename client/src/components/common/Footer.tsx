import React from 'react';
import { Film, Heart } from 'lucide-react';

export const Footer: React.FC = () => {
  return (
    <footer className="w-full border-t border-zinc-800/80 bg-[#0b0d13] py-8 mt-auto">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-zinc-500">
        <div className="flex items-center gap-2">
          <Film className="w-4 h-4 text-red-500" />
          <span className="font-semibold text-zinc-400">CineTrack</span>
          <span>— Precision Movie Watchlists & Collaborative Collections</span>
        </div>
        <div className="flex items-center gap-1">
          <span>This product uses the TMDb API but is not endorsed or certified by TMDb.</span>
        </div>
      </div>
    </footer>
  );
};
