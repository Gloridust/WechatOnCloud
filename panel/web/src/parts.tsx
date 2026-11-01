// 列表里的小部件：名字、失败标记、状态字，以及行内「管理 ▾」菜单。样式见 styles.css「组件层」。

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

// 名字：一行，过长省略，悬停看全名。
export function GridName({ name, className }: { name: string; className?: string }) {
  return (
    <span className={'gname' + (className ? ' ' + className : '')} title={name}>
      {name.trim() || '未命名'}
    </span>
  );
}

// 失败状态：红色胶囊（只用于真正的失败）。
export function PenMark({ children }: { children: ReactNode }) {
  return <span className="tag tag-fail">{children}</span>;
}

// 状态字：文字变化时轻轻淡入（key 随文字变化触发动画）；减弱动效时不动。
export function StateWord({ text }: { text: string }) {
  return (
    <span key={text} className="state-word">
      {text}
    </span>
  );
}

// 行内「管理 ▾」菜单：一行一项、按组分隔、危险项最后且红色。点外部 / Esc 关闭。
// 下方放不下时向上展开，并限高可滚，保证最后一项（通常是删除）始终在视口内。
export type RowMenuItem =
  | { label: string; onClick: () => void; danger?: boolean; title?: string; badge?: ReactNode }
  | { group: string }
  | { sep: true };

export function RowMenu({ items, label = '管理', disabled }: { items: RowMenuItem[]; label?: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const [maxH, setMaxH] = useState<number | undefined>(undefined);
  const wrap = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // 打开时量一下：下方空间不够就向上开；两头都不够就限高滚动
  useLayoutEffect(() => {
    if (!open || !wrap.current || !menu.current) return;
    const r = wrap.current.getBoundingClientRect();
    const h = menu.current.scrollHeight;
    const below = window.innerHeight - r.bottom - 12;
    const above = r.top - 12;
    const goUp = h > below && above > below;
    setUp(goUp);
    const room = goUp ? above : below;
    setMaxH(h > room ? Math.max(160, room) : undefined);
  }, [open]);

  return (
    <div className="row-menu" ref={wrap}>
      <button
        type="button"
        className={'btn row-menu-toggle' + (open ? ' open' : '')}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        {label}
        <svg className="row-menu-caret" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div
          ref={menu}
          className={'row-menu-pop' + (up ? ' up' : '')}
          role="menu"
          style={maxH ? { maxHeight: maxH, overflowY: 'auto' } : undefined}
          onClick={() => setOpen(false)}
        >
          {items.map((it, i) =>
            'group' in it ? (
              <div key={i} className="row-menu-label">
                {it.group}
              </div>
            ) : 'sep' in it ? (
              <div key={i} className="row-menu-sep" />
            ) : (
              <button key={i} type="button" role="menuitem" className={'row-menu-item' + (it.danger ? ' danger' : '')} title={it.title} onClick={it.onClick}>
                {it.label}
                {it.badge}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}
