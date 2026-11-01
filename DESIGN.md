---
name: 云微 · WechatOnCloud panel
description: Self-hosted WeChat / QQ / browser instances, managed on a sheet of squared manuscript paper.
colors:
  paper: "#f5f7f3"
  cell-white: "#ffffff"
  green-cell: "#eaf0eb"
  rule: "#cfdbd2"
  rule-strong: "#8fb39c"
  control-line: "#6a9479"
  carbon-ink: "#18201b"
  pencil: "#56605a"
  green-ink: "#126b40"
  green-ink-fill: "#14693f"
  green-ink-press: "#0f5532"
  status-green: "#1fae63"
  red-pen: "#c2311c"
  red-pen-fill: "#b72d19"
  info-blue: "#2353b8"
  warn-amber: "#835300"
  warn-amber-dot: "#d99a2b"
  carbon-paper: "#10141c"
  carbon-cell: "#171c27"
  carbon-rule: "#283247"
  carbon-rule-strong: "#46557a"
  carbon-control-line: "#64769f"
  carbon-ink-text: "#e4e9f2"
  carbon-pencil: "#9aa4b8"
  carbon-green-ink: "#5dd396"
  carbon-red-pen: "#ff8a73"
typography:
  title:
    fontFamily: "'Noto Serif SC', 'Songti SC', 'STSong', serif"
    fontSize: "26px"
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "0.02em"
  header:
    fontFamily: "'Noto Serif SC', 'Songti SC', 'STSong', serif"
    fontSize: "18px"
    fontWeight: 700
    lineHeight: 1.3
  section:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', sans-serif"
    fontSize: "15px"
    fontWeight: 700
    letterSpacing: "0.04em"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', sans-serif"
    fontSize: "12px"
    fontWeight: 600
  stamp:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', sans-serif"
    fontSize: "11px"
    fontWeight: 700
    letterSpacing: "0.06em"
  figures:
    fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace"
    fontSize: "12px"
    fontWeight: 600
    fontFeature: "tnum"
rounded:
  stamp: "2px"
  control: "3px"
  card: "4px"
spacing:
  cell: "24px"
  half-cell: "12px"
  quarter-cell: "6px"
components:
  button-primary:
    backgroundColor: "{colors.green-ink-fill}"
    textColor: "{colors.cell-white}"
    rounded: "{rounded.control}"
    height: "44px"
    padding: "0 22px"
  button-primary-hover:
    backgroundColor: "{colors.green-ink-press}"
  button-secondary:
    backgroundColor: "{colors.cell-white}"
    textColor: "{colors.carbon-ink}"
    rounded: "{rounded.control}"
    height: "44px"
  button-danger:
    backgroundColor: "{colors.red-pen-fill}"
    textColor: "{colors.cell-white}"
    rounded: "{rounded.control}"
    height: "44px"
  input:
    backgroundColor: "{colors.cell-white}"
    textColor: "{colors.carbon-ink}"
    rounded: "{rounded.control}"
    height: "48px"
    padding: "0 16px"
  stamp-tag:
    textColor: "{colors.green-ink}"
    rounded: "{rounded.stamp}"
    typography: "{typography.stamp}"
    padding: "1px 6px"
  entry-row:
    backgroundColor: "{colors.cell-white}"
    rounded: "{rounded.stamp}"
    padding: "14px 12px"
    height: "72px"
---

# Design System: 云微 · WechatOnCloud panel

## Overview

**Creative North Star: "稿纸 — the manuscript sheet, marked with a red pen"**

The panel is a sheet of Chinese squared manuscript paper (稿纸). Instances are rows written onto it: one ruled table whose rows share columns — index number, name set into square writing cells, a state cell that always says what to do next, and the action. Everything runs on one green-ruled grid.

The app icon is the one fixed brand asset: the green `>_` tile is kept exactly as it was and is never redrawn to fit the paper world. The admin is the teacher with the red pen: anything broken is circled or wavy-underlined in red, with what to do next written beside it.

Depth comes from rules, not light. There are no drop shadows, no glass, no soft blobs. A thin rule frames a card; a thick-and-thin double rule frames the important things (the sheet header, the margin column, dialogs, the login sheet). Dark mode is 复写纸, carbon paper: blue-black ground with pale blue rules.

This replaces the earlier "milk cloth" soft-neumorphism system entirely. Do not bring back raised blobs, radial highlights or pill shapes.

**Key Characteristics:**
- A visible 24px square grid on the paper ground (`--cell`); spacing follows it.
- Ink colours carry meaning: green ink = action and selection, red pen = failure, warning to fix, destructive; carbon ink and pencil grey for everything else.
- Song-style serif for titles; system sans for UI; monospaced tabular figures for numbers and versions.
- Corners nearly square (2–4px). Status labels are stamped boxes, not pills.
- Three signature moves: names in square cells, numbered rows, red-pen marks.
- Every list (instances, accounts, leftover containers/volumes) is the same ruled entry table.

## Colors

Cool paper and carbon ink, with green and red used as ink, never as decoration.

### Primary
- **Green Ink** (#126b40; dark #5dd396): text actions, selected tab and nav item, stamp text for healthy states. 6.1:1 on paper.
- **Green Ink Fill** (#14693f; press #0f5532): the one filled primary button per area, "on" toggles. White text 6.7:1.

### Secondary
- **Red Pen** (#c2311c; dark #ff8a73): failure states, error copy (wavy underline), destructive menu items, the default-password warning. 5.2:1 on paper.
- **Red Pen Fill** (#b72d19): destructive buttons only. White text 6.2:1.

### Tertiary
- **Info Blue** (#2353b8 / dot #3a6fd6): "processing / installing" states.
- **Warn Amber** (#835300 / dot #d99a2b): "upgrade available", "awaiting install".
- **Status Green** (#1fae63): status squares for "online" and progress fill only; never text.

### Neutral
- **Paper** (#f5f7f3): workspace and login ground, carries the grid. Cool, not cream.
- **Cell White** (#ffffff): cards, inputs, sidebar, header.
- **Green Cell** (#eaf0eb): troughs, progress track.
- **Rule** (#cfdbd2) / **Rule Strong** (#8fb39c): hairlines and the double-rule frames (decorative).
- **Control Line** (#6a9479; dark #64769f): boundaries of inputs, secondary buttons, chips, toolbar buttons. ≥3:1 against their ground (WCAG 1.4.11).
- **Carbon Ink** (#18201b): body text. **Pencil** (#56605a): secondary text, 6.1:1.
- Dark: Carbon Paper #10141c, Carbon Cell #171c27, rules #283247 / #46557a, text #e4e9f2, pencil #9aa4b8.

### Named Rules
**The Two Inks Rule.** Only green and red are used as accent ink. Green means "you can act / this is selected / healthy"; red means "broken, fix this, or destroys data". Any other colour must be a state (info, warn) or come from an app's own icon.

**The Quarantine Rule.** Full saturation lives only inside app icons and status squares. Surfaces stay paper, white and rule.

## Typography

**Title font:** Noto Serif SC Bold, self-hosted from `@fontsource/noto-serif-sc` (chunked by unicode-range, only the characters on screen download); system Song only as a pre-load fallback.
**UI font:** platform sans (`PingFang SC`, `Microsoft YaHei`, `Noto Sans SC`)
**Figures:** `ui-monospace` with tabular numerals

**Character:** The serif is the handwriting on the sheet's header; the sans does the work. Numbers line up in columns.

### Hierarchy
- **Title** (700, 26px, 1.25): page greeting on home ("你好，admin").
- **Header** (700, 18px): the sheet header title (主页 / 管理 / instance name), dialog titles.
- **Section** (700, 15px, 0.04em): section headings above a 1px rule.
- **Body** (400, 14px, 1.5): descriptions, card subtitles. Long help text capped at 64ch.
- **Label** (600, 12–13px): field labels, sidebar section label, meta lines.
- **Stamp** (700, 11px, 0.06em): status and version stamps.
- **Figures** (600, 12px mono): entry numbers (01, 02), image versions.

### Named Rules
**The Cell Rule.** An instance's or account's name is written with `GridName` in the title serif: CJK characters one per cell (1.25em); each Latin word in one merged cell about two letters per cell, with cell ticks along the top and bottom edges instead of lines through the letters; spaces don't take cells; at most 10 cells, then "…". Never let a grid name wrap or stretch.

## Layout

- Shell: a left margin column (264px, collapsible to 64px, drawer under 768px) separated from the sheet by a 5px double rule. The sheet header is 52px with a 5px double rule beneath.
- Sheet content: centred, 560px on phones, 940px at ≥880px. Background grid 24px.
- Entry table: `grid-template-columns: 44px minmax(0,1fr) minmax(150px,232px) max-content`; each row is `subgrid`, so state and action columns align down the sheet. Rows are ≥72px (three grid cells), separated by a 1px rule; state and action cells have a 1px column rule. Under 640px a row becomes two lines (name; state | action) with 44px actions. Home ends with a sheet footer line (`共 N 个实例 · 在线 · 需要处理`), echoing 稿纸's "20×15=300" footer.
- Admin: underline tabs (实例 / 用户 / 系统) across the full sheet width; sections are headed by a title over a 1px rule, with any description below the rule.
- Instance page: header holds the toolbar (icon + label). 481–767px: icon-only 44px buttons. ≤480px: 文件 and 输入 stay, everything else moves into a 更多 menu so the instance name stays readable.

## Elevation & Depth

Flat. There are no shadows in this system. Depth and grouping are expressed with rules:

- **Hairline frame** (`box-shadow: 0 0 0 1px var(--rule)`): cards, banners, empty states.
- **Inset rule** (`box-shadow: inset 0 0 0 1px var(--rule-strong)`): secondary buttons, inputs, chips, toolbar buttons. Hover turns it green ink.
- **Double frame** (`--frame-double`: rule, 3px cell-white gap, rule): dialogs, login sheet, the manage menu, toasts.
- **Double border** (`border: 5px double var(--rule-strong)`): the margin column's right edge and the sheet header's bottom edge.

### Named Rules
**The No-Light Rule.** Nothing glows, floats or casts a shadow. If something needs to stand above the page (menu, dialog), give it the double frame.

## Shapes

- Radius: 2px stamps and frames, 3px controls, 4px cards. Nothing round except the theme-toggle glyph.
- Status indicators are small squares, not dots.
- The red-pen circle is the only organic shape: an irregular ellipse (`border-radius: 52% 48% 55% 45% / 58% 46% 54% 42%`, rotated −4°) drawn around a failed state.

## Components

- **Primary button**: Green Ink Fill, white text, 44px, 3px radius; hover darkens; press nudges down 1px. One per card or area.
- **Secondary button**: white with inset rule; hover turns the rule and text green ink.
- **Danger button**: Red Pen Fill, white text; only inside a confirmation dialog.
- **Text action**: green ink text, underline on hover (`+ 新建实例`, `管理 ›`).
- **Input**: white, inset rule, 2px green ink inset ring on focus. Every input has a visible label (placeholder-only labels are not allowed).
- **Stamp tag**: transparent fill, 1px border in the state colour (`currentColor`), 11px bold. Versions use the mono stamp with a neutral rule.
- **Entry row** (`.entry-table > .entry`): No. · icon + GridName + meta · state cell · action cell. The state cell always carries the next step; failures are circled in red pen with the cause wavy-underlined, and sub-accounts read 「请联系管理员」 instead of an action they can't take. The name opens the instance.
- **Row menu** (`RowMenu`, "管理 ▾" / "更多"): double-framed, one item per row, grouped, destructive last and red. Opens upward and caps its height when there's no room below; Esc and outside click close it.
- **Tabs**: underline style; active tab is green ink with a 2px underline.
- **Red-pen note** (default-password banner, failure hints): white card; title wavy-underlined in red; icon in a red-ruled square; action in red.
- **Red-pen circle** (`PenMark`): an authored SVG loop with open, overlapping ends drawn around a failed state word, padded clear of the glyphs.
- **Chip toggle**: a small check box inside the chip; selected = green tint, green outline, filled box.
- **State word**: when a status changes, the word flips in place (`state-flip`, 320ms) and the row never moves. Disabled under reduced motion.
- **Dialog**: double frame, serif title, plain dim mask (no blur), sticky action row under a rule; Esc closes.

## Do's and Don'ts

- **Do** use the tokens in `panel/web/src/styles.css` (`:root`) and the components in `paper.tsx` / `icons.tsx`.
- **Don't** change the logo (`favicon.svg`, PWA icons). It is a fixed brand asset.
- **Do** keep text ≥ 4.5:1 in both themes; green and red text use `--accent` / `--danger`, never the status green.
- **Do** put every list in the entry table, write names with `GridName`, and number rows with `EntryNo`.
- **Do** circle failures with `PenMark`, give the cause with `.pen-wave`, and always show the next step in the state cell.
- **Don't** add drop shadows, glows, glass/blur, gradients or radial highlights.
- **Don't** use pills or large radii; don't use colored side borders on cards or list items.
- **Don't** use emoji or Unicode glyphs as icons; add a line icon to `icons.tsx`.
- **Don't** use the serif for buttons, labels or data.
- **Don't** let a grid name wrap or exceed 10 cells.
