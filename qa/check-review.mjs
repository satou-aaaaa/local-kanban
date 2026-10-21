// アプリの画面を直した PR に、点検（使う人の目線役と UI/UX 専門家役）の記録があるかを見る。ボードの board-src/qa/check-review.mjs・LAST TELL の版ごとのレビューと同じ形。
// 2026-10-21 satouさん「カンバンにも、LAST TELL と同じようなチェック機構を入れてほしい」。手順は reviews/README.md。
// 使い方: node qa/check-review.mjs <比べる元のコミット（PR の base）>
// 見ること（画面のファイルが変わったときだけ）:
//   - sw.js の CACHE の版（kanban-v<番号>）が元より大きい
//   - reviews/v<番号>.md がある
//   - その中に「## 使う人の目線」「## UI/UX 専門家」「## 交代の視点」と、自動の検査の結果の行（「自動：」）がある
//   - 重さ 3・4 の指摘が残っていない（行に「重さ3」「重さ4」があれば、同じ行に「直した」か「satouさんに聞いた」が要る。
//     ボードそのもの（ボードの写し）の指摘はここでは直せないので「ボードのスレッドに渡した」でもよい）
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baseRef = process.argv[2];
if (!baseRef) { console.error('比べる元のコミットを渡してください（例: origin/main）'); process.exit(2); }
const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' });
// 画面に出るもの（ここが変わったら点検が要る）
const SCREEN = /^(index\.html|app\.js|app\.css|boot\.js|shim\.js|talk\.js|voice\.js|koe\.js|localai\.js|ear-worker\.js|bg\/|notes\/index\.html)/;
const changed = git('diff', '--name-only', `${baseRef}...HEAD`).split('\n').filter(Boolean);
const screen = changed.filter((f) => SCREEN.test(f));
let ng = 0; const ok = (c, m) => { console.log(c ? '✓' : '❌', m); if (!c) ng++; };
if (!screen.length) { console.log('✓ 画面のファイルは変わっていない（点検の記録は要らない）'); process.exit(0); }
console.log('・ 変わった画面のファイル: ' + screen.join(' '));
const ver = (s) => +((s.match(/const CACHE = 'kanban-v(\d+)'/) || [])[1] || 0);
let before = ''; try { before = git('show', `${baseRef}:sw.js`); } catch { /* 元に無ければ 0 */ }
const v0 = ver(before), v = ver(readFileSync(resolve(root, 'sw.js'), 'utf8'));
ok(v > 0, 'sw.js に CACHE = \'kanban-v番号\' がある');
ok(v > v0, `版の番号が上がっている（元 v${v0} → 今 v${v}。画面が変わったら sw.js の CACHE を上げる＝端末にも届く）`);
const rp = resolve(root, 'reviews', `v${v}.md`);
const r = existsSync(rp) ? readFileSync(rp, 'utf8') : '';
ok(!!r, `点検の記録 reviews/v${v}.md がある`);
if (r) {
  for (const h of ['## 使う人の目線', '## UI/UX 専門家', '## 交代の視点']) ok(r.includes(h), `「${h}」の節がある`);
  ok(/^自動：/m.test(r), '自動の検査の結果の行（「自動：」で始まる行）がある');
  const left = r.split('\n').filter((l) => /重さ\s*[34]/.test(l) && !/直した|satouさんに聞いた|ボードのスレッドに渡した/.test(l));
  ok(!left.length, '重さ 3・4 の指摘が残っていない' + (left.length ? '（' + left.map((l) => l.trim().slice(0, 40)).join(' / ') + '）' : ''));
}
console.log(ng ? `❌ ${ng} 件（reviews/README.md の手順で点検して記録してください）` : '全部 OK');
process.exit(ng ? 1 : 0);
