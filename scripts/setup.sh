#!/usr/bin/env bash
# 開発の準備を1コマンドで行う。人も、どの AI も同じ手順で動かせるようにするためのもの。何度実行してもよい。
#   使い方: bash scripts/setup.sh   （Windows は Git Bash で）
# Claude Code のクラウドセッションでは .claude/settings.json の SessionStart フックが自動で呼ぶ。
# CI の Setup check（共通部品）が、まっさらな環境でこれが通るかを確かめる。
# ひな形: satou-aaaaa/shared-workflows の template/scripts/setup.sh。アプリ本体はビルド不要なので、要るのは検査（qa/）の部品だけ。
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { echo "✗ $*" >&2; exit 1; }
# 環境変数をクラウドセッションの以後のコマンドに渡す（ほかの環境では何もしない）
session_env() { if [ -n "${CLAUDE_ENV_FILE:-}" ]; then echo "export $1" >> "$CLAUDE_ENV_FILE"; fi; }

# --- Node.js（版は .nvmrc。nvm・fnm・mise・Volta などはこのファイルを読む）---
want=$(tr -dc '0-9' < .nvmrc)
node_ok() { command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge "$want" ]; }
if ! node_ok; then
  # 版が足りず nvm があれば、.nvmrc の版を入れる（Claude Code のクラウドは /opt/nvm にある）
  NVM_DIR=${NVM_DIR:-$HOME/.nvm}; [ -s "$NVM_DIR/nvm.sh" ] || NVM_DIR=/opt/nvm
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    set +u; export NVM_DIR; . "$NVM_DIR/nvm.sh"; nvm install "$want" >/dev/null; set -u
    session_env "PATH=\"$(dirname "$(command -v node)"):\$PATH\""
  fi
fi
node_ok || fail "Node.js $want 以上が要る（今は $(node -v 2>/dev/null || echo なし)。https://nodejs.org/ か、nvm・fnm で .nvmrc の版を入れる）"

# 検査（qa/）の npm の依存を入れる。node_modules が lock より新しければ飛ばす（何度実行しても速い）
if [ ! -f qa/node_modules/.package-lock.json ] || [ qa/package-lock.json -nt qa/node_modules/.package-lock.json ]; then
  (cd qa && npm ci --no-audit --no-fund)
fi

# Playwright のブラウザ。PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 の環境（Claude Code のクラウドなど）は入っているものを使う（qa/ は PW_CHROMIUM を読む）
if [ "${PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD:-}" = 1 ]; then
  hs=$(ls -d /opt/pw-browsers/chromium_headless_shell-*/*/headless_shell 2>/dev/null | head -1 || true)
  if [ -n "$hs" ]; then session_env "PW_CHROMIUM=$hs"; fi
else
  (cd qa && npx playwright install chromium)
fi

echo "✓ 準備できた。次は: node qa/run.mjs（AGENTS.md の「push する前の確認」）"
