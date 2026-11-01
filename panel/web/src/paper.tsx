// 稿纸世界的三个签名小部件：方格名字、编号、就地翻牌的状态字。样式见 styles.css「稿纸世界 · 组件层」。

const MAX_CELLS = 10; // 名字最多占这么多格，超出收成「…」，永远只占一行

interface Cell {
  t: string;
  span: number; // 占几格：汉字 1 格；一个西文单词按每两个字母一格合并成一个宽格（单词不被拆开）
}

// 拆格：汉字一字一格；连续的半角字符是一个「词」，写在合并的宽格里；空格只用来断词，不占格。
function toCells(name: string): Cell[] {
  const cells: Cell[] = [];
  let word = '';
  const flush = () => {
    if (word) cells.push({ t: word, span: Math.max(1, Math.ceil(word.length / 2)) });
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
          className={'gname-c' + (c.t.length > 1 && c.span >= 1 && /^[\x21-\x7e]+$/.test(c.t) ? ' word' : c.t === '·' ? ' sp' : '')}
          style={c.span > 1 ? { width: `calc(var(--gc) * ${c.span})` } : undefined}
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
