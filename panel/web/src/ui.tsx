import {
  cloneElement,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from './icons';

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

const TOAST_ICON: Record<ToastKind, IconName> = { ok: 'checkCircle', error: 'xCircle', info: 'info' };

export function UIProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [confirmState, setConfirmState] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null);
  const seq = useRef(0);

  const toast = useCallback((text: string, kind: ToastKind = 'info') => {
    const id = ++seq.current;
    setToasts((list) => [...list.slice(-3), { id, text, kind }]);
    // 出错的提示多留一会儿：错误通常带着「怎么办」，两秒半读不完
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), kind === 'error' ? 5000 : 2800);
  }, []);

  const confirm = useCallback(
    (opts: ConfirmOpts) => new Promise<boolean>((resolve) => setConfirmState({ ...opts, resolve })),
    [],
  );

  const close = (v: boolean) => {
    confirmState?.resolve(v);
    setConfirmState(null);
  };

  return (
    <Ctx.Provider value={{ toast, confirm }}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={'toast toast-' + t.kind}>
            <Icon name={TOAST_ICON[t.kind]} size={18} />
            <span>{t.text}</span>
          </div>
        ))}
      </div>
      {confirmState && (
        <Modal
          size="sm"
          title={confirmState.title}
          onClose={() => close(false)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => close(false)}>
                {confirmState.cancelText || '取消'}
              </button>
              <button
                type="button"
                className={'btn ' + (confirmState.danger ? 'btn-danger' : 'btn-primary')}
                onClick={() => close(true)}
                autoFocus
              >
                {confirmState.confirmText || '确定'}
              </button>
            </>
          }
        >
          {confirmState.body && <p className="modal-text">{confirmState.body}</p>}
        </Modal>
      )}
    </Ctx.Provider>
  );
}

export const useUI = () => useContext(Ctx);

// ── 弹窗 ────────────────────────────────────────────────
// 统一的结构：标题栏（标题 + 关闭）/ 可滚动的内容 / 吸底的操作区。Esc 只关最上面那一层（确认框叠在弹窗上时）；
// 在弹窗里按下鼠标拖到遮罩上松开（选文字常见）不算点遮罩，不会误关。
const modalStack: number[] = [];
let modalSeq = 0;
const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

export function Modal({
  title,
  subtitle,
  onClose,
  children,
  footer,
  size = 'md',
  onSubmit,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children?: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  onSubmit?: (e: FormEvent) => void;
  className?: string;
}) {
  const id = useRef(++modalSeq).current;
  const titleId = useId();
  const box = useRef<HTMLDivElement & HTMLFormElement>(null);
  const downOnMask = useRef(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    modalStack.push(id);
    const prev = document.activeElement as HTMLElement | null;
    // 没有自带 autoFocus 的控件时，把焦点放到弹窗本身，读屏和 Tab 都从这里开始
    if (box.current && !box.current.contains(document.activeElement)) box.current.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (modalStack[modalStack.length - 1] !== id) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeRef.current();
      } else if (e.key === 'Tab' && box.current) {
        // Tab 在弹窗里循环，不跑到被遮住的页面上去
        const list = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
        if (!list.length) return;
        const first = list[0];
        const last = list[list.length - 1];
        const a = document.activeElement;
        if (!box.current.contains(a) || (e.shiftKey && (a === first || a === box.current))) {
          e.preventDefault();
          (e.shiftKey ? last : first).focus();
        } else if (!e.shiftKey && a === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      const i = modalStack.indexOf(id);
      if (i >= 0) modalStack.splice(i, 1);
      prev?.focus?.({ preventScroll: true });
    };
  }, [id]);

  const Tag = (onSubmit ? 'form' : 'div') as 'div';
  return createPortal(
    <div
      className="modal-mask"
      onMouseDown={(e) => (downOnMask.current = e.target === e.currentTarget)}
      onClick={(e) => {
        if (e.target === e.currentTarget && downOnMask.current) onClose();
      }}
    >
      <Tag
        ref={box}
        className={`modal modal-${size}` + (className ? ' ' + className : '')}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        {...(onSubmit ? { onSubmit } : {})}
      >
        <div className="modal-head">
          <div className="modal-titles">
            <h2 id={titleId}>{title}</h2>
            {subtitle && <div className="modal-subtitle">{subtitle}</div>}
          </div>
          <button type="button" className="icon-btn modal-x" aria-label="关闭" title="关闭（Esc）" onClick={onClose}>
            <Icon name="x" size={18} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </Tag>
    </div>,
    document.body,
  );
}

// ── 下拉菜单 ────────────────────────────────────────────
// 挂到 body 上用 fixed 定位：卡片有 overflow:hidden 也裁不到它；靠近屏幕底边时自动往上弹。
export interface MenuItem {
  label: string;
  icon?: IconName;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  hint?: string; // 悬停提示
  desc?: string; // 标签下面的一行说明（需要解释清楚的选项，比如输入方式）
  checked?: boolean; // 给了就是单选项：选中的右侧打勾
}
export type MenuEntry = MenuItem | { section: string } | 'sep' | null | false | undefined;

export function MenuButton({
  items,
  label = '更多操作',
  icon = 'more',
  text,
  textClassName,
  className = 'icon-btn',
  align = 'end',
}: {
  items: MenuEntry[];
  label?: string;
  icon?: IconName;
  text?: string;
  textClassName?: string;
  className?: string;
  align?: 'start' | 'end';
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; up: boolean } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const entries = items.filter(Boolean) as Exclude<MenuEntry, null | false | undefined>[];

  // 优先放按钮下面，放不下就放上面；上下都放不下（矮屏幕上靠中间的卡片）就贴着视口底边，
  // 盖住一点按钮也比伸出屏幕强——伸出去的那几项（数据卷、删除实例）根本点不到。比视口还高时由 max-height 在菜单里滚动
  const place = useCallback(() => {
    const b = btn.current?.getBoundingClientRect();
    const m = menu.current;
    if (!b || !m) return;
    const w = m.offsetWidth;
    const h = m.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = align === 'end' ? b.right - w : b.left;
    left = Math.max(8, Math.min(left, vw - w - 8));
    let top: number;
    let up = false;
    if (b.bottom + 6 + h <= vh - 8) top = b.bottom + 6;
    else if (b.top - 6 - h >= 8) {
      top = b.top - 6 - h;
      up = true;
    } else {
      top = Math.max(8, vh - 8 - h);
      up = top < b.top;
    }
    setPos({ top, left, up });
  }, [align]);

  useLayoutEffect(() => {
    if (open) place();
    else setPos(null);
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      const t = e.target as Node;
      if (menu.current?.contains(t) || btn.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        btn.current?.focus();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const list = [...(menu.current?.querySelectorAll<HTMLButtonElement>('.menu-item:not(:disabled)') || [])];
        if (!list.length) return;
        const i = list.indexOf(document.activeElement as HTMLButtonElement);
        const n = e.key === 'ArrowDown' ? (i + 1) % list.length : (i - 1 + list.length) % list.length;
        list[n].focus();
      }
    };
    // 页面滚动 / 窗口变化就收起；菜单自己内部滚动（项多、屏幕矮时）不算
    const onMove = (e: Event) => {
      if (e.type === 'scroll' && e.target instanceof Node && menu.current?.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btn}
        type="button"
        className={className + (open ? ' open' : '')}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name={icon} size={18} />
        {text && <span className={textClassName}>{text}</span>}
      </button>
      {open &&
        createPortal(
          <div
            ref={menu}
            className={'menu' + (pos?.up ? ' up' : '')}
            role="menu"
            style={pos ? { top: pos.top, left: pos.left } : { visibility: 'hidden', top: 0, left: 0 }}
          >
            {entries.map((en, i) =>
              en === 'sep' ? (
                <div key={i} className="menu-sep" role="separator" />
              ) : 'section' in en ? (
                <div key={i} className="menu-section">
                  {en.section}
                </div>
              ) : (
                <button
                  key={i}
                  type="button"
                  role={en.checked === undefined ? 'menuitem' : 'menuitemradio'}
                  aria-checked={en.checked}
                  className={'menu-item' + (en.danger ? ' danger' : '') + (en.desc ? ' has-desc' : '') + (en.checked ? ' checked' : '')}
                  disabled={en.disabled}
                  title={en.hint}
                  onClick={() => {
                    setOpen(false);
                    en.onClick?.();
                  }}
                >
                  {en.icon ? <Icon name={en.icon} size={17} /> : <span className="menu-ic-gap" />}
                  {en.desc ? (
                    <span className="menu-item-text">
                      <span className="menu-item-label">{en.label}</span>
                      <span className="menu-item-desc">{en.desc}</span>
                    </span>
                  ) : (
                    <span className="menu-item-text">{en.label}</span>
                  )}
                  {en.checked && <Icon name="check" size={16} strokeWidth={2.6} className="menu-check" />}
                </button>
              ),
            )}
          </div>,
          document.body,
        )}
    </>
  );
}

// ── 表单字段：标签 + 控件 + 说明 / 错误 ─────────────────
// 子元素是单个输入控件（input / select / textarea / PasswordInput）时自动关联：标签点得着、读屏念得出标签和说明
export function Field({ label, hint, error, children, htmlFor }: { label?: ReactNode; hint?: ReactNode; error?: ReactNode; children: ReactNode; htmlFor?: string }) {
  const autoId = useId();
  const msgId = autoId + '-msg';
  let control: ReactNode = children;
  let forId = htmlFor;
  if (!forId && isValidElement(children)) {
    const t = children.type;
    const native = typeof t === 'string' && ['input', 'select', 'textarea'].includes(t);
    if (native || t === PasswordInput) {
      const props = children.props as { id?: string };
      forId = props.id || autoId;
      control = cloneElement(children as ReactElement<any>, {
        id: forId,
        ...(native && (error || hint) ? { 'aria-describedby': msgId } : {}),
      });
    }
  }
  return (
    <div className="field">
      {label && (
        <label className="field-label" htmlFor={forId}>
          {label}
        </label>
      )}
      {control}
      {error ? (
        <div className="field-error" id={msgId}>
          {error}
        </div>
      ) : hint ? (
        <div className="field-hint" id={msgId}>
          {hint}
        </div>
      ) : null}
    </div>
  );
}

// ── 带"显示/隐藏"切换的密码输入框 ────────────────────────
export function PasswordInput({
  value,
  onChange,
  placeholder,
  autoComplete,
  autoFocus,
  id,
  invalid,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoComplete?: string;
  autoFocus?: boolean;
  id?: string;
  invalid?: boolean;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="pw-field">
      <input
        id={id}
        className={'input' + (invalid ? ' invalid' : '')}
        type={show ? 'text' : 'password'}
        placeholder={placeholder}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        aria-invalid={invalid || undefined}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        className="pw-toggle"
        tabIndex={-1}
        aria-label={show ? '隐藏密码' : '显示密码'}
        title={show ? '隐藏密码' : '显示密码'}
        onClick={() => setShow((s) => !s)}
      >
        <Icon name={show ? 'eyeOff' : 'eye'} size={19} />
      </button>
    </div>
  );
}

// 浏览器标签页标题：开着好几个实例的标签页时能分清是哪个
export function useDocTitle(title: string) {
  useEffect(() => {
    document.title = title ? `${title} · 云微` : '云微';
  }, [title]);
}

// 转圈：按钮里用 sm，整块区域加载用 md
export function Spinner({ size = 'md' }: { size?: 'sm' | 'md' }) {
  return <span className={'spinner' + (size === 'sm' ? ' spinner-sm' : '')} aria-label="加载中" />;
}
