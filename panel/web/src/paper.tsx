// 稿纸世界的三个签名小部件：方格名字、编号、就地翻牌的状态字。样式见 styles.css「稿纸世界 · 组件层」。

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

const MAX_CELLS = 10; // 名字最多占这么多格，超出收成「…」，永远只占一行

interface Cell {
  t: string;
  span: number; // 占几格：汉字 1 格；一个西文单词按每两个字母一格合并成一个宽格（单词不被拆开）
}

// 拆格：汉字一字一格；连续的半角字符是一个「词」，写在跨若干格的合并格里（格线照画，字母不被拆开）；空格只用来断词，不占格。
function toCells(name: string): Cell[] {
  const cells: Cell[] = [];
  let word = '';
  const flush = () => {
    if (word) cells.push({ t: word, span: Math.max(1, Math.ceil(word.length / 1.9)) }); // 西文约两个字母一格，整词放得下
    word = '';
  };
  for (const ch of Array.from(name.trim())) {
    if (ch === ' ') {
      flush();
    } else if (/^[\x21-\x7e]$/.test(ch)) {
      word += ch;
    } else {
      flush();
      cells.push({ t: ch, span: 1 });
    }
  }
  flush();
  return cells.length ? cells : [{ t: '未命名', span: 3 }];
}

// 名字写进方格。读屏只读一遍完整名字（.sr-only），格子本身对读屏隐藏。
export function GridName({ name, className }: { name: string; className?: string }) {
  const shown: Cell[] = [];
  let used = 0;
  let more = false;
  for (const c of toCells(name)) {
    if (used + c.span > MAX_CELLS - 1) {
      // 放不下：一个超长单词就截断在剩余格数里，其余收成「…」
      const room = MAX_CELLS - 1 - used;
      if (room > 0 && c.span > 1) shown.push({ t: c.t.slice(0, room * 2), span: room });
      more = true;
      break;
    }
    shown.push(c);
    used += c.span;
  }
  return (
    <span className={'gname' + (className ? ' ' + className : '')} title={name}>
      <span className="sr-only">{name}</span>
      {shown.map((c, i) => (
        <span
          key={i}
          className={'gname-c' + (/^[\x21-\x7e]+$/.test(c.t) ? ' word' : c.t === '·' ? ' sp' : '')}
          style={{ width: `calc(var(--gc) * ${c.span})` }}
          aria-hidden="true"
        >
          {c.t}
        </span>
      ))}
      {more && (
        <span className="gname-c gname-more" aria-hidden="true">
          …
        </span>
      )}
    </span>
  );
}

// 实例序号：01、02……像稿纸页码，按列表顺序编。
export function EntryNo({ n }: { n: number }) {
  return <span className="entry-no">{String(n).padStart(2, '0')}</span>;
}

// 状态字：文字一变就翻一次牌（key 随文字变化，触发 CSS 动画）；减弱动效时不翻。
export function StateWord({ text }: { text: string }) {
  return (
    <span key={text} className="state-word">
      {text}
    </span>
  );
}

// 红笔圈：手画的不闭合圈（两端交叠），SVG 线条，留足边距不压字。用于圈出失败状态。
export function PenMark({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={'pen-circle' + (className ? ' ' + className : '')}>
      {children}
      <svg className="pen-loop" viewBox="0 0 120 44" preserveAspectRatio="none" aria-hidden="true" focusable="false">
        <path d="M96 6C74 1 34 2 15 9 3 14 2 27 10 34c11 9 51 9 79 6 19-3 29-11 27-20C114 11 97 5 70 5 52 5 38 7 30 10" />
      </svg>
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
