/// <reference types="node" />

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  buildClickInInstanceCommand,
  buildKeyInInstanceCommand,
  buildPasteClipboardInInstanceCommand,
  buildTypeInInstanceCommand,
} from './docker';

function assertValidBash(command: string) {
  const result = spawnSync('bash', ['-n'], {
    input: command,
    encoding: 'utf8',
  });
  assert.equal(
    result.status,
    0,
    result.stderr || `invalid bash command: ${command}`,
  );
}

test('remote click command maps ratios against the full display geometry', () => {
  const cmd = buildClickInInstanceCommand(0.5, 0.8);

  assert.match(cmd, /xdotool getdisplaygeometry/);
  assert.doesNotMatch(cmd, /getactivewindow getwindowgeometry/);
  assert.match(cmd, /xdotool mousemove "\$px" "\$py" click 1/);
  assert.doesNotMatch(cmd, /mousemove --sync/);
});

test('remote click command clamps invalid ratios before building the shell command', () => {
  const cmd = buildClickInInstanceCommand(2, -1);

  assert.match(cmd, /-v x="1"/);
  assert.match(cmd, /-v y="0"/);
});

test('typing command can focus the target point before pasting text', () => {
  const cmd = buildTypeInInstanceCommand('你好 A1,', { xRatio: 0.5, yRatio: 0.8 });

  assertValidBash(cmd);
  assert.match(cmd, /xdotool getdisplaygeometry/);
  assert.match(cmd, /xdotool mousemove "\$px" "\$py" click 1/);
  assert.match(cmd, /xclip -selection clipboard -loops 2 -i/);
  assert.match(cmd, /xdotool key --clearmodifiers ctrl\+v/);
  assert.ok(cmd.indexOf('xdotool mousemove "$px" "$py" click 1') < cmd.indexOf('xclip -selection clipboard -loops 2 -i'));
  assert.ok(cmd.indexOf('xclip -selection clipboard -loops 2 -i') < cmd.indexOf('xdotool key --clearmodifiers ctrl+v'));
});

test('typing command does not read the clipboard back on every immediate input chunk', () => {
  const cmd = buildTypeInInstanceCommand('你');

  assertValidBash(cmd);
  assert.match(cmd, /xclip -selection clipboard -loops 2 -i/);
  assert.doesNotMatch(cmd, /xclip -selection clipboard -o/);
  assert.doesNotMatch(cmd, /clipboard did not sync expected text/);
  assert.match(cmd, /xdotool key --clearmodifiers ctrl\+v/);
});

test('typing command starts a short-lived clipboard owner before pasting', () => {
  const cmd = buildTypeInInstanceCommand('快');

  assertValidBash(cmd);
  assert.match(cmd, /xclip -selection clipboard -loops 2 -i/);
  assert.doesNotMatch(cmd, /xclip -selection clipboard -loops 1 -i/);
  assert.match(cmd, /& clip_pid="\$!"/);
  assert.match(cmd, /sleep 0\.03/);
  assert.match(cmd, /xdotool key --clearmodifiers ctrl\+v/);
  assert.ok(cmd.indexOf('clip_pid="$!"') < cmd.indexOf('xdotool key --clearmodifiers ctrl+v'));
});

test('focused paste command clicks the target point before sending paste', () => {
  const cmd = buildPasteClipboardInInstanceCommand(0.5, 0.8);

  assert.match(cmd, /xdotool getdisplaygeometry/);
  assert.match(cmd, /xdotool mousemove "\$px" "\$py" click 1/);
  assert.match(cmd, /xdotool key --clearmodifiers ctrl\+v/);
  assert.doesNotMatch(cmd, /xclip -selection clipboard -i/);
  assert.ok(cmd.indexOf('xdotool mousemove "$px" "$py" click 1') < cmd.indexOf('xdotool key --clearmodifiers ctrl+v'));
});

test('focused paste command can wait for the expected clipboard text before pasting', () => {
  const cmd = buildPasteClipboardInInstanceCommand(0.5, 0.8, '你好 B2,');

  assertValidBash(cmd);
  assert.match(cmd, /xclip -selection clipboard -o/);
  assert.match(cmd, /clipboard did not sync expected text/);
  assert.match(cmd, /for i in 1/);
  assert.match(cmd, /timeout 0\.03s xclip/);
  assert.doesNotMatch(cmd, /for i in 1 2 3 4 5/);
  assert.doesNotMatch(cmd, /timeout 0\.2s xclip/);
  assert.doesNotMatch(cmd, /xclip -selection clipboard -i/);
  assert.ok(cmd.indexOf('xclip -selection clipboard -o') < cmd.indexOf('xdotool key --clearmodifiers ctrl+v'));
  assert.ok(cmd.indexOf('clipboard did not sync expected text') < cmd.indexOf('xdotool key --clearmodifiers ctrl+v'));
});

test('focused paste command checks expected clipboard only briefly before fallback', () => {
  const cmd = buildPasteClipboardInInstanceCommand(0.5, 0.8, '你好 B2,');

  assert.match(cmd, /for i in 1;/);
  assert.match(cmd, /timeout 0\.03s xclip/);
  assert.doesNotMatch(cmd, /sleep 0\.02/);
});

test('key command resolves aliases with display setup', () => {
  const cmd = buildKeyInInstanceCommand('Ctrl+A');

  assert.match(cmd, /export DISPLAY="\$\{display:-:1\}"/);
  assert.match(cmd, /command -v xdotool/);
  assert.match(cmd, /xdotool key --clearmodifiers ctrl\+a/);
});

test('key command rejects unsupported keys', () => {
  assert.throws(() => buildKeyInInstanceCommand('F13'), /按键不支持/);
});
