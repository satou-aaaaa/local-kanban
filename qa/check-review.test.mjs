// qa/check-review.mjs の「版の番号が今の main より大きいか」を、仮のリポジトリで試す（node --test qa/check-review.test.mjs）。
// 2026-10-29 Issue #87：PR #81・#82 が同じ元（v56）から同じ v57 を取り、#81 が先にマージ。#82 は元とだけ比べていたので通ってしまい、main とぶつかって止まった。
// その形を作り、直す前の検査（元とだけ比べる）では通ってしまうこと・今の検査では落ちること・v59 に付け直せば通ることを見る。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = resolve(dirname(fileURLToPath(import.meta.url)), 'check-review.mjs');
const REVIEW = '# 点検\n写真：12枚\n自動：✅\n## 使う人の目線\nよい\n## UI/UX 専門家\nよい\n## 交代の視点\nよい\n';

function repo() {
  const d = mkdtempSync(join(tmpdir(), 'lk-review-'));
  const g = (...a) => execFileSync('git', a, { cwd: d, encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 'qa@example.com'); g('config', 'user.name', 'qa');
  mkdirSync(join(d, 'reviews'));
  const put = (v, extra = '') => {
    writeFileSync(join(d, 'sw.js'), `const CACHE = 'kanban-v${v}';\n`);
    writeFileSync(join(d, 'app.js'), `// ${v}${extra}\n`);
    writeFileSync(join(d, 'reviews', `v${v}.md`), REVIEW);
    g('add', '-A'); g('commit', '-q', '-m', `v${v}${extra}`);
  };
  return { d, g, put };
}
const run = (d, base, mainRef) => spawnSync('node', [script, base], { env: { ...process.env, LK_ROOT: d, ...(mainRef ? { LK_MAIN_REF: mainRef } : {}) }, encoding: 'utf8' });

test('ほかの PR が同じ版で先にマージしたら落ち、次の空き版に付け直せば通る', () => {
  const { d, g, put } = repo();
  try {
    put(56); const base = g('rev-parse', 'HEAD');
    g('checkout', '-q', '-b', 'pr82'); put(57, ' pr82');            // #82：v56 から v57
    g('checkout', '-q', 'main'); put(57, ' pr81');                  // #81：同じ v57 で先にマージ
    g('checkout', '-q', 'pr82');
    // 直す前の検査と同じ見方（main を見ない＝main の無い名前を渡す）では通ってしまう
    assert.equal(run(d, base, 'no-such-ref').status, 0, '元とだけ比べると通る（これが見逃しの形）');
    const ng = run(d, base, 'main');
    assert.equal(ng.status, 1, '今の main と同じ v57 なので落ちる\n' + ng.stdout);
    assert.match(ng.stdout, /今の main（main は v57）より大きい/);
    // main を取り込み v58 に付け直す……のではなく、main がさらに v58 まで進んでいた #87 の形で、v59 にする
    g('checkout', '-q', 'main'); put(58, ' pr85'); g('checkout', '-q', 'pr82');
    put(59, ' pr82');
    const ok = run(d, base, 'main');
    assert.equal(ok.status, 0, 'v59 なら通る\n' + ok.stdout);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
