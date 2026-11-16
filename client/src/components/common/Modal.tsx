import React, { useEffect } from 'react';
import { X } from 'lucide-react';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  children: React.ReactNode;
  maxWidth?: 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl';
  showCloseButton?: boolean;
}

export const Modal: React.FC<ModalProps> = ({
  isOpen,
  onClose,
  title,
  children,
  maxWidth = 'lg',
  showCloseButton = true,
}) => {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    if (isOpen) {
      document.body.style.overflow = 'hidden';
      window.addEventListener('keydown', handleKeyDown);
    }
    return () => {
      document.body.style.overflow = 'unset';
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const maxWidthStyles = {
    sm: 'max-w-sm',
    md: 'max-w-md',
    lg: 'max-w-lg',
    xl: 'max-w-xl',
    '2xl': 'max-w-2xl',
    '3xl': 'max-w-3xl',
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="flex min-h-full items-center justify-center p-4">
        {/* Backdrop */}
        <div
          className="fixed inset-0 bg-black/80 backdrop-blur-sm transition-opacity"
          aria-hidden="true"
          onClick={onClose}
        />

        {/* Modal Dialog Content */}
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby={typeof title === 'string' ? 'modal-dialog-title' : undefined}
          aria-label={typeof title !== 'string' ? 'Dialog' : undefined}
          className={`relative w-full ${maxWidthStyles[maxWidth]} rounded-2xl bg-[#121620] border border-zinc-800 shadow-2xl z-10 overflow-hidden my-8`}
          onClick={(e) => e.stopPropagation()}
        >
          {title ? (
            <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800/80">
              <h3 id="modal-dialog-title" className="text-lg font-semibold text-slate-100">
                {title}
              </h3>
              {showCloseButton && (
                <button
                  type="button"
                  data-testid="modal-close-button"
                  aria-label="Close dialog"
                  onClick={onClose}
                  className="text-zinc-400 hover:text-slate-100 p-2 rounded-lg hover:bg-zinc-800/60 transition-colors min-w-[40px] min-h-[40px] flex items-center justify-center focus:outline-none focus:ring-2 focus:ring-red-500"
                >
                  <X className="w-5 h-5" />
                </button>
              )}
            </div>
          ) : (
            showCloseButton && (
              <button
                type="button"
                data-testid="modal-close-button"
                aria-label="Close dialog"
                onClick={onClose}
                className="absolute top-4 right-4 z-40 p-2.5 rounded-full bg-black/70 hover:bg-black/90 text-white border border-white/20 shadow-xl transition-all hover:scale-105 active:scale-95 min-w-[44px] min-h-[44px] flex items-center justify-center focus:outline-none focus:ring-2 focus:ring-red-500"
              >
                <X className="w-5 h-5 text-white" />
              </button>
            )
          )}
          <div className="p-6">{children}</div>
        </div>
      </div>
    </div>
  );
};
