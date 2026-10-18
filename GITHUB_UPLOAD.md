# GitHubへの登録

このフォルダの**中身**をリポジトリのルートへ配置してください。`README.md` と `package.json` がGitHubのトップに並ぶ構成です。

`.git`、個人のスライド、保存一覧、キー・トークン、ビルド済みアプリは含みません。`.gitignore` と `.github/` はドットで始まるためFinderでは非表示になることがあります。

## Gitで登録する場合

GitHubで空のpublicリポジトリを作成します。以下の例では `SogenHanda/slide-studio` を使っています。別名で作った場合はURLを変更してください。

展開したフォルダをターミナルで開き、実行します。

```bash
git init -b main
git add .
git commit -m "Add Slide Studio 4"
git remote add origin https://github.com/SogenHanda/slide-studio.git
git push -u origin main
```

`gh`で認証してHTTPS pushを使う場合、先に次を実行してください。

```bash
gh auth login --hostname github.com --git-protocol https --web
gh auth setup-git
```

GitHub側ですでにREADME等を作成した場合は、上記の新規初期化手順ではなく、そのリポジトリをcloneしてからこのフォルダの中身をコピーしてコミットしてください。履歴を強制上書きする必要はありません。

## ブラウザやGitHub Desktopを使う場合

GitHub Desktopで作成済みリポジトリをcloneし、その作業フォルダへこのフォルダの中身をコピーしてCommit・Pushできます。

ブラウザではリポジトリの「Add file → Upload files」で登録できます。ZIPそのものではなく、展開後のファイル・フォルダを登録してください。非表示の `.gitignore` と `.github/` も含めるには、ターミナルかGitHub Desktopからの登録を使うと確実です。

ビルド済みMacアプリのZIPはソースリポジトリに追加せず、配布が必要な場合にGitHub Releasesへ添付してください。
