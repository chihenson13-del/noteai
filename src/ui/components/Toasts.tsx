import { X } from 'lucide-react';
import { useToastStore } from '../../state/toastStore';

export function Toasts() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);
  return (
    <div className="toasts" aria-live="polite" aria-atomic="false">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast--${toast.tone}`} role={toast.tone === 'error' ? 'alert' : 'status'}>
          <span className="grow">{toast.message}</span>
          <button
            type="button"
            aria-label="Dismiss notification"
            onClick={() => dismiss(toast.id)}
            style={{ background: 'none', border: 0, color: 'inherit', cursor: 'pointer', padding: 0 }}
          >
            <X size={18} />
          </button>
        </div>
      ))}
    </div>
  );
}
