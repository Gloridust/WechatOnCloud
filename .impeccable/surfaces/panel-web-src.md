---
version: 1
slug: "panel-web-src"
primary_target: "panel/web/src"
related_targets: []
---

# Surface brief · panel (all routes: login, home, admin, instance)

Scope: the whole 云微 panel. Mode: Operate. Build path: code-led (Operate surfaces are code-led by contract).
Audience/job: self-hoster admin and non-technical sub-account users, equally; open an instance fast, see health, fix failures.
Constraints: the logo is fixed (never change it); thin chrome around the KasmVNC iframe; zh-CN; 390px phones to wide desktop; light + dark; WCAG AA.
Decision round: user asked not to pause; the assigned direction was built without a decision page (disclosed in chat).

## Grounded candidates (ordered by resonance)
1. 快递柜 parcel-locker wall · 2. 门牌 blue-enamel house plates · 3. 中国邮政 green postal counter · 4. 软纸火车票 train ticket · 5. 搪瓷 enamelware · 6. 稿纸 squared manuscript paper + 红笔批改 (ASSIGNED) · 7. 夜市灯箱 light-box signage

## Challenger verdicts
- split-flap concourse board: competitive (audience identification) · raise kept: status words change in place cell by cell, the row never moves.
- dark developer console: declined · raise kept: destructive actions isolated by deliberate empty space.
- factory catalog sleeve: declined · raise kept: every instance carries an index number (No.01) in strict sequence.
- lexicon shoulder & plate: declined · raise kept: colour quarantined; full colour only in app icons and state marks.
- streaming title wall / transit diagram: declined.

## Direction contract
THESIS: The panel is a sheet of 稿纸 — squared manuscript paper — and the admin is the teacher with the red pen. Refuses the category default of soft grey cards with drop shadows and one accent.
OWN-WORLD: Cool paper white ground ruled by a faint green square module (24px cells); carbon-ink text; deep 绿格 green ink for actions and selection; vermilion red pen only for errors, warnings to fix and destructive actions. Frames are a thick+thin double rule, corners nearly square (2–4px), no shadows. Dark theme is 复写纸 carbon paper: blue-black ground, pale blue rules. Song-style serif for page titles, system sans for UI, tabular figures.
STORY: The visitor sees their instances as numbered entries written into the grid, reads each one's state as a word in a ruled cell, and opens one in a click; anything broken is circled in red with what to do next.
FIRST VIEWPORT: Left margin column (the existing `>_` logo, unchanged by user instruction; numbered instance list with failures in red pen, admin/logout) separated from the sheet by a 5px double rule. The sheet: serif greeting with an instance count, a red-pen note when the default password is still in use, then one ruled table whose rows share columns (subgrid): No. | icon + name in square cells | state cell with the next step | primary action (进入 / 启动 / 重试创建 / 下载安装, or 请联系管理员 for sub-accounts). Admin, users and system lists use the same table plus a 管理 ▾ menu. Phones: two lines per row, 44px actions.
AMENDMENT (after finish review, disposition rebuild): earlier wording said "2-col table"; built as a single shared-column table, which reads as one sheet and keeps state/action columns aligned at every width.
FORM: 稿纸 manuscript paper, my list position 6 of 7. seed:912dde73f3117499. Signature move: names set in square writing cells; red-pen circle/underline marks for failures.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
