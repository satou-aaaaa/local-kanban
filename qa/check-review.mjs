// アプリの画面を直した PR に、点検（使う人の目線役と UI/UX 専門家役）の記録があるかを見る。ボードの board-src/qa/check-review.mjs・LAST TELL の版ごとのレビューと同じ形。
// 2026-10-21 satouさん「カンバンにも、LAST TELL と同じようなチェック機構を入れてほしい」。手順は reviews/README.md。
// 使い方: node qa/check-review.mjs <比べる元のコミット（PR の base）>
// 見ること（画面のファイルが変わったときだけ）:
//   - sw.js の CACHE の版（kanban-v<番号>）が元より大きい
//   - その版が今の main（origin/main。先に git fetch する）の版よりも大きい（2026-10-29 Issue #87：並行した PR #81・#82 が同じ v57 を取り、
//     元とだけ比べていたので両方通り、#82 が main とぶつかって1日半止まった。比べる main は LK_MAIN_REF で替えられる）
//   - reviews/v<番号>.md がある
//   - その中に「## 使う人の目線」「## UI/UX 専門家」「## 交代の視点」と、自動の検査の結果の行（「自動：」）・見せた写真の行（「写真：」）がある
//   - 押せる部品の数の基準を上げたら「## 増やした押す所」がある（画面のファイルが変わっていなくても）
//   - 重さ 3・4 の指摘が残っていない（行に「重さ3」「重さ4」があれば、同じ行に「直した」か「satouさんに聞いた」が要る。
//     ボードそのもの（ボードの写し）の指摘はここでは直せないので「ボードのスレッドに渡した」でもよい）
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.env.LK_ROOT ? resolve(process.env.LK_ROOT) : resolve(dirname(fileURLToPath(import.meta.url)), '..'); // LK_ROOT は qa/check-review.test.mjs が仮のリポジトリで試すとき
const baseRef = process.argv[2];
if (!baseRef) { console.error('比べる元のコミットを渡してください（例: origin/main）'); process.exit(2); }
const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' });
// 画面に出るもの（ここが変わったら点検が要る）
const SCREEN = /^(index\.html|app\.js|app\.css|boot\.js|shim\.js|talk\.js|voice\.js|koe\.js|localai\.js|ear-worker\.js|bg\/|notes\/index\.html)/;
const changed = git('diff', '--name-only', `${baseRef}...HEAD`).split('\n').filter(Boolean);
const screen = changed.filter((f) => SCREEN.test(f));
let ng = 0; const ok = (c, m) => { console.log(c ? '✓' : '❌', m); if (!c) ng++; };
// 押せる部品の数の基準（qa/uiux-baseline.json）を上げた PR は、点検の記録に「## 増やした押す所」が要る（画面のファイルが変わっていなくても見る）
// 2026-10-21 satouさん「ボタンが増えたことによって、UI/UXに影響がでていると思います。こちらのチェックも」（前にも言った）
const BASE = 'qa/uiux-baseline.json';
let grown = [];
if (changed.includes(BASE)) {
  let b0 = {}; try { b0 = JSON.parse(git('show', `${baseRef}:${BASE}`)); } catch { /* 元に無ければ増えていない */ }
  const b1 = JSON.parse(readFileSync(resolve(root, BASE), 'utf8'));
  for (const [kind, scenes] of Object.entries(b1)) for (const [k, m] of Object.entries(scenes)) for (const f of ['first', 'taps']) {
    const was = b0[kind]?.[k]?.[f]; if ((was == null && m[f] > 0) || (was != null && m[f] > was)) grown.push(`${kind}・${k} の${f === 'first' ? '最初の画面' : '全部'} ${was ?? '新規'}→${m[f]}`);
  }
}
if (!screen.length && !grown.length) { console.log('✓ 画面のファイルは変わっていない（点検の記録は要らない）'); process.exit(0); }
console.log('・ 変わった画面のファイル: ' + screen.join(' '));
const ver = (s) => +((s.match(/const CACHE = 'kanban-v(\d+)'/) || [])[1] || 0);
let before = ''; try { before = git('show', `${baseRef}:sw.js`); } catch { /* 元に無ければ 0 */ }
const v0 = ver(before), v = ver(readFileSync(resolve(root, 'sw.js'), 'utf8'));
ok(v > 0, 'sw.js に CACHE = \'kanban-v番号\' がある');
ok(v > v0, `版の番号が上がっている（元 v${v0} → 今 v${v}。画面が変わったら sw.js の CACHE を上げる＝端末にも届く）`);
// 今の main とも比べる（元より上でも、ほかの PR が先に同じ版でマージしていればぶつかる）。取れないとき（オフラインなど）は手元の origin/main で比べる
const mainRef = process.env.LK_MAIN_REF || 'origin/main';
let fetchFailed = false;
if (!process.env.LK_MAIN_REF) { try { execFileSync('git', ['fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main'], { cwd: root, stdio: 'ignore', timeout: 30000 }); } catch { fetchFailed = true; /* 手元では取れなくても手元のもので見る */ } }
// CI（LK_REQUIRE_MAIN=1）では、最新の main を取れなかったら落とす（古い origin/main と比べて通すと、同じ版の重なりを見逃す）
if (fetchFailed && process.env.LK_REQUIRE_MAIN === '1') ok(false, `最新の main を取れなかった（git fetch origin main が失敗。古い ${mainRef} とは比べない）`);
let onMain = null; try { onMain = git('show', `${mainRef}:sw.js`); } catch { /* main が無い（仮のリポジトリなど）ときは見ない */ }
// CI（LK_REQUIRE_MAIN=1）では、main と比べられなければ落とす（比べずに通すと、同じ版の重なりを見逃す）
if (onMain == null && process.env.LK_REQUIRE_MAIN === '1') ok(false, `今の main（${mainRef}）の sw.js を読めない（git fetch origin main ができるか確かめる）`);
if (onMain != null) {
  const vm = ver(onMain);
  ok(v > vm, `版の番号が今の main（${mainRef} は v${vm}）より大きい（今 v${v}。同じなら、ほかの PR が先にその版でマージした：main を取り込み、v${vm + 1} に上げて reviews/v${vm + 1}.md に付け直す）`);
}
const rp = resolve(root, 'reviews', `v${v}.md`);
const r = existsSync(rp) ? readFileSync(rp, 'utf8') : '';
ok(!!r, `点検の記録 reviews/v${v}.md がある`);
if (r) {
  for (const h of ['## 使う人の目線', '## UI/UX 専門家', '## 交代の視点']) ok(r.includes(h), `「${h}」の節がある`);
  ok(/^自動：/m.test(r), '自動の検査の結果の行（「自動：」で始まる行）がある');
  ok(/^写真：/m.test(r), '点検役に見せた画面写真の行（「写真：」で始まる行。どの画面・幅・色を何枚）がある（ボードの点検と同じ。写真を見ずに点検しない）');
  if (grown.length) {
    const sec = (r.split(/^## 増やした押す所\s*$/m)[1] || '').split(/^## /m)[0].trim();
    ok(sec.length >= 20, `押せる部品を増やした（${grown.join('、')}）ので、「## 増やした押す所」に何を足したか・なぜ要るか・代わりに減らした／しまったものを書いてある`);
  }
  const left = r.split('\n').filter((l) => /重さ\s*[34]/.test(l) && !/直した|satouさんに聞いた|ボードのスレッドに渡した/.test(l));
  ok(!left.length, '重さ 3・4 の指摘が残っていない' + (left.length ? '（' + left.map((l) => l.trim().slice(0, 40)).join(' / ') + '）' : ''));
}
console.log(ng ? `❌ ${ng} 件（reviews/README.md の手順で点検して記録してください）` : '全部 OK');
process.exit(ng ? 1 : 0);
