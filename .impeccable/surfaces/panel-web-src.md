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

## Direction history
1. Refinement of the soft-neumorphic original (PR #173): rejected as not different enough.
2. 稿纸 squared manuscript paper (rolled direction, seed:912dde73f3117499): built and reviewed, then rejected by the user as "primitive"; the user wants rounded edges.
3. The user chose **A: iOS grouped list** from three rounded mockups (A iOS grouped list, B modern app with dark sidebar, C refined soft cards). User-pinned direction; it beats the roll.

## Direction contract
THESIS: The panel is iOS Settings for your own WeChat server: calm, familiar grouped lists where every row says what to do next. Refuses both heavy neumorphic blobs and square, bordered "tool" chrome.
OWN-WORLD: Light gray page (#f2f3f5), white 18px-radius groups with a barely-there lift, inset hairline separators, tinted status pills, pill buttons with one green primary (#06843f), system sans with large bold titles. Dark: black page, #1c1c1e groups. The `>_` logo is fixed.
STORY: The visitor sees their instances as one grouped list, reads each one's state as a colored pill, and opens or fixes it from the same row; failures say why and what to do.
FIRST VIEWPORT: White sidebar (logo, nav, instance list with status dots), large bold greeting with an instance count, the default-password banner when relevant, then one grouped list: icon · name · subtitle · note · status pill · action. Phones: two-line rows, 44px actions.
FORM: User-pinned direction A (iOS grouped list), chosen from three rounded mockups after the rolled 稿纸 direction (seed:912dde73f3117499) was rejected.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
