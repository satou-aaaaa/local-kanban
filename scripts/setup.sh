#!/usr/bin/env bash
# 開発の準備を1コマンドで行う。人も、どの AI も同じ手順で動かせるようにするためのもの。何度実行してもよい。
#   使い方: bash scripts/setup.sh   （Windows は Git Bash で）
# Claude Code のクラウドセッションでは .claude/settings.json の SessionStart フックが自動で呼ぶ。
# CI の Setup check（共通部品）が、まっさらな環境でこれが通るかを確かめる。
# ひな形: satou-aaaaa/shared-workflows の template/scripts/setup.sh。アプリ本体はビルド不要なので、要るのは検査（qa/）の部品だけ。
# ひな形の版: 2（ブラウザの探し方と名前 PW_CHROMIUM だけこのリポジトリ用）
#   2: 依存は毎回 npm ci・ブラウザが無ければ止める・このシェルで要る操作（nvm use・export）を最後に出す（shared-workflows incidents/2026-11-03-setup-false-ready.md）
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { echo "✗ $*" >&2; exit 1; }
# 準備のあと、このシェルで打つ必要がある操作。1つでもあれば最後に「✓」を出さない
todo=()
# 環境変数を以後のコマンドに渡す。クラウドセッションは CLAUDE_ENV_FILE に書く。
# それ以外は子のプロセスから親のシェルを変えられないので、打つ操作として最後に出す
session_env() {
  if [ -n "${CLAUDE_ENV_FILE:-}" ]; then echo "export $1" >> "$CLAUDE_ENV_FILE"; else todo+=("export $1"); fi
}

# --- Node.js（版は .nvmrc。nvm・fnm・mise・Volta などはこのファイルを読む）---
want=$(tr -dc '0-9' < .nvmrc)
node_ok() { command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge "$want" ]; }
if ! node_ok; then
  # 版が足りず nvm があれば、.nvmrc の版を入れる（Claude Code のクラウドは /opt/nvm にある）
  NVM_DIR=${NVM_DIR:-$HOME/.nvm}; [ -s "$NVM_DIR/nvm.sh" ] || NVM_DIR=/opt/nvm
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    set +u; export NVM_DIR; . "$NVM_DIR/nvm.sh"; nvm install "$want" >/dev/null; set -u
    if node_ok; then
      # nvm の切り替えはこのスクリプトの中だけに効く（親のシェルは古い Node のまま）
      if [ -n "${CLAUDE_ENV_FILE:-}" ]; then session_env "PATH=\"$(dirname "$(command -v node)"):\$PATH\""; else todo+=("nvm use $want"); fi
    fi
  fi
fi
node_ok || fail "Node.js $want 以上が要る（今は $(node -v 2>/dev/null || echo なし)。https://nodejs.org/ か、nvm・fnm で .nvmrc の版を入れる）"

# 検査（qa/）の npm の依存。毎回 lock から入れ直す（日付だけで飛ばすと、消えた・別の版に替わった node_modules を見逃す）
(cd qa && npm ci --no-audit --no-fund)

# Playwright のブラウザ。PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 の環境（Claude Code のクラウドなど）は入っているものを使う（qa/ は PW_CHROMIUM を読む）
if [ "${PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD:-}" = 1 ]; then
  # 名前は Playwright の版で違う（headless_shell・chrome-headless-shell）。CI と同じ headless shell を優先し、無ければ普通の chromium
  hs=''
  for f in /opt/pw-browsers/chromium_headless_shell-*/*/headless_shell /opt/pw-browsers/chromium_headless_shell-*/*/chrome-headless-shell /opt/pw-browsers/chromium; do
    if [ -x "$f" ]; then hs=$f; break; fi
  done
  if [ -n "${PW_CHROMIUM:-}" ]; then
    [ -x "$PW_CHROMIUM" ] || fail "PW_CHROMIUM=$PW_CHROMIUM が動かせない（ブラウザの場所を直すか、unset PW_CHROMIUM）"
  elif [ -n "$hs" ]; then
    session_env "PW_CHROMIUM=$hs"
  else
    def=$(cd qa && node -e 'try{process.stdout.write(require("playwright").chromium.executablePath())}catch{}' 2>/dev/null || true)
    [ -n "$def" ] && [ -x "$def" ] || fail "使えるブラウザが無い（PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 で取ってこない設定）。PW_CHROMIUM にブラウザの場所を入れるか、(cd qa && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD= npx playwright install chromium)"
  fi
else
  (cd qa && npx playwright install chromium)
fi

next="node qa/run.mjs（AGENTS.md の「push する前の確認」）"
if [ ${#todo[@]} -gt 0 ]; then
  echo "△ 準備はできた。ただし、このシェルで先に次を打つ（打たないと古い Node や別のブラウザで動く）:"
  printf '    %s\n' "${todo[@]}"
  echo "  そのあと: $next"
else
  echo "✓ 準備できた。次は: $next"
fi
