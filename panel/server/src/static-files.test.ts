import { describe, it, expect } from 'vitest';

/**
 * Regression test for: SPA static files not served after runtime update
 * Root cause: @fastify/static with wildcard:false only registers routes
 * for files present at boot time. Files copied in later (e.g. docker cp)
 * return 404 / index.html fallback instead of the actual file.
 * Fix: wildcard must be true so the plugin handles all files dynamically.
 */
describe('Static file serving regression', () => {
  it('must use wildcard:true for runtime asset updates', () => {
    const fs = require('fs');
    const indexSrc = fs.readFileSync(__dirname + '/index.ts', 'utf-8');
    const match = indexSrc.match(/wildcard:\s*(true|false)/);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('true');
  });
});

/**
 * Regression test for: OIDC button styles nested inside .btn-danger:active
 * Root cause: sed inserted OIDC styles inside .btn-danger:active rule block,
 * causing browsers to parse them as .btn-danger:active .oidc-button (descendant
 * selector), which never matched the actual button.
 * Fix: Insert styles at top-level, after .btn-text.danger:active rule.
 */
describe('CSS style placement regression', () => {
  it('must not nest .oidc-button inside .btn-danger:active', () => {
    const fs = require('fs');
    const css = fs.readFileSync(__dirname + '/../../web/src/styles.css', 'utf-8');

    // Find .btn-danger:active block and check it closes before .oidc-button
    const dangerIdx = css.indexOf('.btn-danger:active:not(:disabled) {');
    expect(dangerIdx).toBeGreaterThan(-1);

    const dangerEnd = css.indexOf('}', dangerIdx);
    expect(dangerEnd).toBeGreaterThan(-1);

    const oidcIdx = css.indexOf('.oidc-button {');
    expect(oidcIdx).toBeGreaterThan(-1);

    // .oidc-button must come AFTER .btn-danger:active closes
    expect(oidcIdx).toBeGreaterThan(dangerEnd);

    // Verify .oidc-button has green background
    const oidcBlock = css.slice(oidcIdx, css.indexOf('}', oidcIdx));
    expect(oidcBlock).toContain('background: var(--wx-green)');
    expect(oidcBlock).toContain('color: #fff');
  });
});
