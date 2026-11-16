import React from 'react';
import { Sun, Moon } from 'lucide-react';
import { useTheme } from '../../context/ThemeContext';

interface ThemeToggleProps {
  className?: string;
  showLabel?: boolean;
}

export const ThemeToggle: React.FC<ThemeToggleProps> = ({
  className = '',
  showLabel = false,
}) => {
  const { theme, toggleTheme } = useTheme();

  return (
    <button
      type="button"
      data-testid="theme-toggle-button"
      onClick={toggleTheme}
      aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
      title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
      className={`min-w-[40px] min-h-[40px] p-2 rounded-xl flex items-center gap-2 transition-all duration-200 border ${
        theme === 'dark'
          ? 'bg-zinc-900/90 text-amber-400 border-zinc-800 hover:border-zinc-700 hover:bg-zinc-850'
          : 'bg-white text-indigo-600 border-slate-200 hover:border-slate-300 hover:bg-slate-50 shadow-sm'
      } ${className}`}
    >
      {theme === 'dark' ? (
        <Sun className="w-4 h-4 shrink-0 transition-transform hover:rotate-45" />
      ) : (
        <Moon className="w-4 h-4 shrink-0 transition-transform hover:-rotate-12" />
      )}
      {showLabel && (
        <span className="text-xs font-semibold">
          {theme === 'dark' ? 'Light Mode' : 'Dark Mode'}
        </span>
      )}
    </button>
  );
};
