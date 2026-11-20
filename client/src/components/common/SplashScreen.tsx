import React from 'react';
import { Film } from 'lucide-react';
import { useTheme } from '../../context/ThemeContext';

interface SplashScreenProps {
  isLoading?: boolean;
}

export const SplashScreen: React.FC<SplashScreenProps> = ({ isLoading = true }) => {
  const { theme } = useTheme();
  if (!isLoading) return null;

  const isLight = theme === 'light';

  return (
    <div
      data-testid="pwa-splash-screen"
      className={`fixed inset-0 z-50 flex flex-col items-center justify-center transition-colors duration-300 ${
        isLight ? 'bg-slate-50 text-slate-900' : 'bg-[#0b0d13] text-white'
      }`}
    >
      <div className="flex flex-col items-center gap-4 animate-fade-in text-center px-4">
        {/* Animated Brand Icon */}
        <div className="relative w-20 h-20 rounded-3xl bg-gradient-to-br from-red-600 via-rose-600 to-rose-700 flex items-center justify-center shadow-2xl shadow-red-950/60 glow-cinematic">
          <Film className="w-10 h-10 text-white" />
        </div>

        {/* Wordmark */}
        <div className="space-y-1">
          <h1 className={`text-3xl font-extrabold tracking-tight ${isLight ? 'text-slate-900' : 'text-white'}`}>
            Cine<span className="text-red-500">Track</span>
          </h1>
          <p className={`text-xs font-medium tracking-wide ${isLight ? 'text-slate-500' : 'text-zinc-400'}`}>
            Your Personal Media Library
          </p>
        </div>

        {/* Subtle loading indicator */}
        <div className="mt-6 flex items-center gap-1.5">
          <div className="w-2 h-2 rounded-full bg-red-500 animate-bounce" style={{ animationDelay: '0ms' }} />
          <div className="w-2 h-2 rounded-full bg-red-500 animate-bounce" style={{ animationDelay: '150ms' }} />
          <div className="w-2 h-2 rounded-full bg-red-500 animate-bounce" style={{ animationDelay: '300ms' }} />
        </div>
      </div>
    </div>
  );
};
