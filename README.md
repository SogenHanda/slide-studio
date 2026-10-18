# Slide Studio

HTML/CSS/JavaScriptの編集画面と、Swift製のmacOSアプリを持つスライド制作ツールです。テキスト・画像・動画・音声を配置し、Codexとの会話から編集案を作成できます。

**バージョン：4.0.0 / 試用版**

## 主な機能

- テキストボックス内で直接編集。選択した文字だけサイズ・太字を変更。
- 画像・動画・音声、YouTube・Vimeo、図形、表、棒グラフを配置。
- 移動・リサイズ・整列・重なり順・グループ化・Undo/Redo。
- 発表全体または1枚だけ保存し、プレビュー付き一覧から検索・再編集。
- 保存したスライドを別の発表に追加。参照素材も引き継ぎ。
- 下書きの自動保存とMac版の作業状態復元。
- `.slide`、HTML、Markdown、SVG、PNG、印刷経由のPDF出力。
- CodexのChatGPTログイン、またはOpenAI APIによる会話形式の編集提案。
- 発表者ノート、発表者画面、WebSocketによる外部システムとのキュー連携。

リアルタイム共同編集は未実装です。同じローカルサービスの保存項目に対する更新競合を検出し、先に保存された変更を上書きしない仕組みを備えています。

## 必要な環境

| 用途 | 必要な環境 |
| --- | --- |
| ローカルブラウザ版 | Node.js 22以上、Chrome等の現行ブラウザ |
| Macアプリのビルド | macOS 15以降、Xcodeまたは対応するSwift開発環境、Node.js 22以上 |
| Codex接続 | 公式ChatGPT/Codexアプリ、またはCodex CLIと有効なログイン |
| OpenAI API接続 | APIキーとAPI利用環境。ChatGPTプランとは別途課金 |

JavaScript側に外部npm依存はありません。通常の起動に `npm install` は不要です。

このリポジトリには、ビルド済みの `.app` やNode実行ファイルは含みません。Macビルド時に、手元の互換Nodeバイナリをアプリへ同梱します。

## ローカルブラウザ版を起動

リポジトリのルートで実行します。

```bash
npm start
```

表示されたローカルURL（通常は `http://127.0.0.1:4317`）を開きます。サーバーは `127.0.0.1` だけで待ち受けます。

Macでは `start-slide-studio.command` からも起動できます。

AIやサーバー側への保存を使う場合は、起動時に表示される `Bridge token` を画面の「AI設定 → ローカル接続トークン」に入力して保存してください。

編集画面を単独HTMLにまとめる場合：

```bash
npm run build
```

生成される `dist/slide-studio.html` をブラウザで開けます。AI接続や一部の埋め込み・同期機能にはローカルサーバーが必要です。

## Macアプリをビルド

```bash
npm run build:mac
```

`release/Slide Studio.app` が生成されます。Node実行ファイルとWeb画面を同梱し、アプリがローカルサービスを起動します。利用時のターミナル起動やBridge tokenの手入力は不要です。

ビルドスクリプトはmacOSのシステムライブラリ以外に依存するNodeを拒否します。Node公式配布版など、外部dylib依存のないバイナリを利用してください。実行ファイルを明示する場合：

```bash
SLIDE_STUDIO_NODE_BIN=/absolute/path/to/node npm run build:mac
```

既存の出力を上書きしない設計です。再ビルドは別の出力先を指定します。

```bash
SLIDE_STUDIO_BUILD_DIR="$PWD/release-next" npm run build:mac
```

Apple Silicon版はApple SiliconのMacと対応Nodeでビルドしてください。Intel向けのビルド・動作は未検証です。

現在のビルドはアドホック署名です。Developer ID署名・Appleの公証・自動アップデートは含まれません。

## 保存と再利用

- **保存 / ⌘ S**：発表全体を保存一覧へ保存。同じ発表は同じ項目を更新。
- **この1枚を保存**：選択中の1枚と参照素材を別項目として保存。
- **別名で保存 / ⌘ Shift S**：既存項目を保持して新しい項目を作成。
- **保存一覧 → 開く**：保存した発表を再編集。
- **今の発表に追加**：保存項目のスライドと素材を現在の発表へ取り込み。
- **下書き保存**：編集中の状態を自動保存。保存一覧への明示保存とは別です。

| 実行方法 | 保存先 |
| --- | --- |
| Mac版 | `~/Library/Application Support/Slide Studio/saved-presentations/` |
| ローカルサーバーへ接続済みのブラウザ版 | データディレクトリの `saved-presentations/` |
| サーバー未接続のブラウザ版 | そのブラウザ・オリジンのIndexedDB |

これらの保存領域は自動同期されません。ブラウザ版からMac版への移行は、旧版で `.slide` に書き出してMac版で取り込んでください。

ファイルとして読み込んだ素材はプロジェクトに含まれます。外部URLの素材やYouTube/Vimeoは元の公開状態とネット接続に依存します。チャットの参考添付は、素材として明示的に追加しない限りプロジェクトには含まれません。

## Codex・AI設定

1. AI設定で「Codex · ChatGPTでログイン」を選択。
2. 「接続確認・モデル取得」を実行。
3. 必要ならログインを完了して、利用可能なモデルを選択。
4. 会話で作成・修正を依頼し、変更案を確認して適用。

公式Codex App Serverを子プロセスとして使用します。既存のChatGPTチャットやメモリーを自動で取得する機能はありません。モデルは接続先が返す一覧から選択し、利用可否はアカウント・クライアント側に依存します。推論強度は現在 `medium` です。

検出順は、環境変数による明示指定、PATH上のCodex、ChatGPTアプリ内のCodex、Codexアプリ内のCodexです。Codexやそのログイン情報をこのリポジトリへ同梱しないでください。

AIへ送る情報は会話、スライドの文章・ノート・配置・素材名、参考添付の文章と画像です。添付以外の素材本体は送信しません。会話、APIキー、Bridge tokenはプロジェクトに含まれません。会話とチャット添付は永続保存しません。Codexログイン情報は公式CLIが管理します。

AIの提案は、画面から適用するまでスライドへ反映しません。Codexスレッドはread-onlyとし、ツールの実行・任意ファイル編集・承認は提供しません。

## 環境変数

| 変数 | 用途 |
| --- | --- |
| `SLIDE_STUDIO_PORT` | ローカルサーバーのポート。標準4317 |
| `SLIDE_STUDIO_DATA_DIR` | プロジェクト・保存一覧のデータディレクトリ |
| `SLIDE_STUDIO_TOKEN` | ローカル接続トークン。未指定時は起動ごとに生成 |
| `SLIDE_STUDIO_CODEX_BIN` | Codex実行ファイルの絶対パス |
| `SLIDE_STUDIO_CODEX_TIMEOUT_MS` | Codex生成の待機上限。標準600000、最大3600000 |
| `SLIDE_STUDIO_NODE_BIN` | Macビルドに同梱するNodeのパス |
| `SLIDE_STUDIO_BUILD_DIR` | Macビルドの出力先 |
| `OPENAI_API_KEY` | ブラウザ版のAPI方式で使用するキー。Codex認証には使用しない |

Mac版は専用のデータディレクトリ・空きポート・ランダムトークンを自動設定します。

## 開発・テスト

```bash
npm run check
npm run build
npm test
```

構文、保存・再読み込み、素材の保持、更新競合、スライドの再利用、部分書式、AI操作の検証、認証を確認します。ネットワーク接続部分は模擬応答を使います。一部の文書抽出テストはMac専用です。

Swiftコンパイル、同梱ファイルの自己診断、アドホック署名の整合性は確認済みです。ネイティブ画面の実操作、実際のCodex生成・画像理解、動画埋め込み・複数ディスプレイでの実機確認は未実施です。

## ファイル構成

```text
README.md                  概要・起動・保存・開発手順
GITHUB_UPLOAD.md           作成したGitHubリポジトリへの登録方法
dist/                      Web編集画面と単独HTML
native/                    SwiftのMacアプリ本体
scripts/build-macos.sh      Mac版ビルド
server.mjs                 ローカルHTTP / WebSocket / AI接続
project-store.mjs          保存一覧と下書きの永続化
codex-bridge.mjs           Codex App Server接続
attachments.mjs           チャット添付の受付・文書抽出
build.mjs                  単独HTML生成
tests/                     自動テスト
.github/workflows/         JavaScript側のCI
```

## 対応範囲

PPTX/Keynoteの読み書き、リアルタイム共同編集、クラウド同期、公開Web版、ノードエディタは未実装です。PDFや画像出力では動画・音声を再生できません。PNG/SVGの外部画像はCORSやフォント差の影響を受けます。ブラウザとファイルの双方に保存する場合、大容量素材によるメモリ・ディスク使用量に注意してください。

ソースの公開にライセンスはまだ付与していません。再配布・改変の許諾条件を定める場合は、所有者がライセンスを選択して追加してください。
