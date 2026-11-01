import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

// ── Toast ───────────────────────────────────────────────
type ToastKind = 'ok' | 'error' | 'info';
interface ToastItem {
  id: number;
  text: string;
  kind: ToastKind;
}

// ── Confirm ─────────────────────────────────────────────
interface ConfirmOpts {
  title: string;
  body?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

interface UICtx {
  toast: (text: string, kind?: ToastKind) => void;
  confirm: (opts: ConfirmOpts) => Promise<boolean>;
}

const Ctx = createContext<UICtx>(null!);

export function UIProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [confirmState, setConfirmState] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null);
  const seq = useRef(0);

  const toast = useCallback((text: string, kind: ToastKind = 'info') => {
    const id = ++seq.current;
    setToasts((list) => [...list, { id, text, kind }]);
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), 2600);
  }, []);

  const confirm = useCallback(
    (opts: ConfirmOpts) => new Promise<boolean>((resolve) => setConfirmState({ ...opts, resolve })),
    [],
  );

  // Esc 关闭最上层弹窗：所有弹窗都是「点遮罩即关闭」，这里统一把 Esc 映射成点最上层遮罩，不必每个弹窗各写一遍
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const masks = document.querySelectorAll<HTMLElement>('.modal-mask');
      const top = masks[masks.length - 1];
      if (top) {
        e.preventDefault();
        top.click();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const close = (v: boolean) => {
    confirmState?.resolve(v);
    setConfirmState(null);
  };

  return (
    <Ctx.Provider value={{ toast, confirm }}>
      {children}
      <div className="toast-stack">
        {toasts.map((t) => (
          <div key={t.id} className={'toast toast-' + t.kind}>
            {t.text}
          </div>
        ))}
      </div>
      {confirmState && (
        <div className="modal-mask" onClick={() => close(false)}>
          <div className="card modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 340 }}>
            <h2>{confirmState.title}</h2>
            {confirmState.body && <div className="muted" style={{ fontSize: 14, lineHeight: 1.5 }}>{confirmState.body}</div>}
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => close(false)}>
                {confirmState.cancelText || '取消'}
              </button>
              <button
                type="button"
                className={'btn ' + (confirmState.danger ? 'btn-danger' : 'btn-primary')}
                onClick={() => close(true)}
              >
                {confirmState.confirmText || '确定'}
              </button>
            </div>
          </div>
        </div>
      )}
    </Ctx.Provider>
  );
}

export const useUI = () => useContext(Ctx);

// ── 带"显示/隐藏"切换的密码输入框 ────────────────────────
export function PasswordInput({
  value,
  onChange,
  placeholder,
  autoComplete,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoComplete?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="pw-field">
      <input
        className="input"
        type={show ? 'text' : 'password'}
        placeholder={placeholder}
        aria-label={placeholder}
        autoComplete={autoComplete}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        className="pw-toggle"
        aria-label={show ? '隐藏密码' : '显示密码'}
        aria-pressed={show}
        onClick={() => setShow((s) => !s)}
      >
        {show ? (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20C5 20 1 12 1 12a18.5 18.5 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19M1 1l22 22" />
            <path d="M9.5 9.5a3 3 0 0 0 4.24 4.24" />
          </svg>
        ) : (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        )}
      </button>
    </div>
  );
}
