import React from 'react';
import { Check } from 'lucide-react';

interface CustomCheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: React.ReactNode;
  description?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
  dataTestId?: string;
}

export const CustomCheckbox: React.FC<CustomCheckboxProps> = ({
  checked,
  onChange,
  label,
  description,
  disabled = false,
  id,
  className = '',
  dataTestId,
}) => {
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      onChange(!checked);
    }
  };

  return (
    <div
      role="checkbox"
      aria-checked={checked}
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      id={id}
      data-testid={dataTestId}
      onClick={() => {
        if (!disabled) {
          onChange(!checked);
        }
      }}
      onKeyDown={handleKeyDown}
      className={`group flex items-center gap-3 min-h-[44px] px-3 py-2 rounded-xl cursor-pointer select-none transition-all outline-none focus-visible:ring-2 focus-visible:ring-amber-500/60 ${
        checked
          ? 'bg-amber-500/10 border border-amber-500/30'
          : 'bg-zinc-900/50 hover:bg-zinc-800/60 border border-zinc-800/80 hover:border-zinc-700'
      } ${disabled ? 'opacity-50 cursor-not-allowed' : ''} ${className}`}
    >
      {/* Custom styled square checkbox box */}
      <div
        className={`w-5 h-5 rounded-md flex items-center justify-center border transition-all shrink-0 ${
          checked
            ? 'bg-amber-500 border-amber-400 text-black shadow-sm'
            : 'border-zinc-600 bg-zinc-800/80 group-hover:border-zinc-500 text-transparent'
        }`}
      >
        <Check
          className={`w-3.5 h-3.5 stroke-[3] transition-transform ${
            checked ? 'scale-100' : 'scale-0'
          }`}
        />
      </div>

      {/* Label and optional description */}
      {(label || description) && (
        <div className="flex-1 min-w-0">
          {label && (
            <div
              className={`text-xs font-semibold truncate transition-colors ${
                checked ? 'text-amber-200' : 'text-zinc-300 group-hover:text-white'
              }`}
            >
              {label}
            </div>
          )}
          {description && (
            <div className="text-[11px] text-zinc-400 truncate">{description}</div>
          )}
        </div>
      )}
    </div>
  );
};
