import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  children: React.ReactNode;
  maxWidth?: 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl';
  showCloseButton?: boolean;
}

// Module-level reference counting to support nested modals and preserve original styles
let activeModalCount = 0;
let originalBodyOverflow = '';

export const Modal: React.FC<ModalProps> = ({
  isOpen,
  onClose,
  title,
  children,
  maxWidth = 'lg',
  showCloseButton = true,
}) => {
  const modalRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedElementRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);

  // Keep stable reference to onClose without triggering effect restarts
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!isOpen) return;

    // Save previous active element for focus restoration upon modal close
    previouslyFocusedElementRef.current = document.activeElement as HTMLElement;

    // Manage body scroll locking with reference counter
    if (activeModalCount === 0) {
      originalBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    activeModalCount++;

    // Focus first focusable element inside modal on initial open
    const focusTimer = setTimeout(() => {
      if (modalRef.current) {
        const focusable = modalRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        );
        if (focusable.length > 0) {
          focusable[0].focus();
        } else {
          modalRef.current.focus();
        }
      }
    }, 50);

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCloseRef.current();
        return;
      }

      // Accessible Focus Trap: loop focus within modal
      if (e.key === 'Tab' && modalRef.current) {
        const focusableElements = Array.from(
          modalRef.current.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
          )
        ).filter((el) => el.offsetParent !== null);

        if (focusableElements.length === 0) {
          e.preventDefault();
          return;
        }

        const firstElement = focusableElements[0];
        const lastElement = focusableElements[focusableElements.length - 1];

        if (e.shiftKey) {
          if (document.activeElement === firstElement || !modalRef.current.contains(document.activeElement)) {
            e.preventDefault();
            lastElement.focus();
          }
        } else {
          if (document.activeElement === lastElement || !modalRef.current.contains(document.activeElement)) {
            e.preventDefault();
            firstElement.focus();
          }
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      clearTimeout(focusTimer);
      window.removeEventListener('keydown', handleKeyDown);

      // Decrement reference counter and restore body overflow when all modals are closed
      activeModalCount = Math.max(0, activeModalCount - 1);
      if (activeModalCount === 0) {
        document.body.style.overflow = originalBodyOverflow;
      }

      // Restore focus to original activeElement
      if (previouslyFocusedElementRef.current && previouslyFocusedElementRef.current.focus) {
        previouslyFocusedElementRef.current.focus();
      }
    };
  }, [isOpen]);

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
          onClick={() => onCloseRef.current()}
        />

        {/* Modal Dialog Content */}
        <div
          ref={modalRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-labelledby={typeof title === 'string' ? 'modal-dialog-title' : undefined}
          aria-label={typeof title !== 'string' ? 'Dialog' : undefined}
          className={`relative w-full ${maxWidthStyles[maxWidth]} rounded-2xl bg-[#121620] border border-zinc-800 shadow-2xl z-10 overflow-hidden my-8 outline-none`}
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
                  onClick={() => onCloseRef.current()}
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
                onClick={() => onCloseRef.current()}
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
