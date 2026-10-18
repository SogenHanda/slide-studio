#!/bin/zsh
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null; then
  echo "Node.js 22以上をインストールしてから、もう一度開いてください。"
  read "?Enterで閉じる"
  exit 1
fi
echo "表示されるローカルURLをChromeで開いてください。"
echo "AI接続設定には、このあと表示されるBridge tokenを入力します。"
exec node server.mjs
