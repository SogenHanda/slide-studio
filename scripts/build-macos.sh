#!/bin/bash
set -euo pipefail
STUDIO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STUDIO_OUT="${SLIDE_STUDIO_BUILD_DIR:-$STUDIO_ROOT/release}"
STUDIO_APP="$STUDIO_OUT/Slide Studio.app"
STUDIO_NODE="${SLIDE_STUDIO_NODE_BIN:-$(command -v node)}"
mkdir -p "$STUDIO_OUT" /tmp/slide-studio-swift-cache
if [ -e "$STUDIO_APP" ]; then
  echo '既存のSlide Studio.appが出力先にあります。別のSLIDE_STUDIO_BUILD_DIRを指定してください。' >&2
  exit 1
fi
# Only package a portable Node distribution; do not copy dependent Homebrew dylibs.
if otool -L "$STUDIO_NODE" | tail -n +2 | awk '{print $1}' | grep -Ev '^(/System/|/usr/lib/)' >/dev/null; then
  echo 'Nodeに外部dylib依存があります。nodejs.org配布版のNodeを指定してください。' >&2
  exit 1
fi
node "$STUDIO_ROOT/build.mjs"
mkdir -p "$STUDIO_APP/Contents/MacOS" "$STUDIO_APP/Contents/Resources/runtime" "$STUDIO_APP/Contents/Resources/studio/dist"
xcrun swiftc -swift-version 5 -O -parse-as-library -module-cache-path /tmp/slide-studio-swift-cache -framework Cocoa -framework WebKit "$STUDIO_ROOT/native/SlideStudio.swift" -o "$STUDIO_APP/Contents/MacOS/SlideStudio"
cp "$STUDIO_NODE" "$STUDIO_APP/Contents/Resources/runtime/node"
STUDIO_NODE_ROOT="$(cd "$(dirname "$STUDIO_NODE")/.." && pwd)"
if [ -f "$STUDIO_NODE_ROOT/LICENSE" ]; then cp "$STUDIO_NODE_ROOT/LICENSE" "$STUDIO_APP/Contents/Resources/runtime/NODE-LICENSE"; fi
cp "$STUDIO_ROOT/"{server.mjs,project-store.mjs,codex-bridge.mjs,attachments.mjs,package.json} "$STUDIO_APP/Contents/Resources/studio/"
cp "$STUDIO_ROOT/dist/"{index.html,app.js,advanced.js,library.js,style.css,advanced.css,library.css} "$STUDIO_APP/Contents/Resources/studio/dist/"
cat > "$STUDIO_APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Slide Studio</string>
<key>CFBundleDisplayName</key><string>Slide Studio</string>
<key>CFBundleIdentifier</key><string>jp.sogen.slidestudio</string>
<key>CFBundleExecutable</key><string>SlideStudio</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>4.0.0</string>
<key>CFBundleVersion</key><string>400</string>
<key>LSMinimumSystemVersion</key><string>15.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/><key>NSAllowsArbitraryLoadsInWebContent</key><true/></dict>
<key>CFBundleDocumentTypes</key><array><dict><key>CFBundleTypeName</key><string>Slide Studio Project</string><key>CFBundleTypeRole</key><string>Editor</string><key>LSHandlerRank</key><string>Owner</string><key>CFBundleTypeExtensions</key><array><string>slide</string></array></dict></array>
</dict></plist>
PLIST
STUDIO_ICONSET="$STUDIO_OUT/SlideStudio.iconset"
mkdir -p "$STUDIO_ICONSET"
xcrun swift -module-cache-path /tmp/slide-studio-swift-cache "$STUDIO_ROOT/native/Icon.swift" "$STUDIO_ICONSET"
if iconutil -c icns "$STUDIO_ICONSET" -o "$STUDIO_APP/Contents/Resources/SlideStudio.icns" 2>/dev/null; then
  /usr/libexec/PlistBuddy -c 'Add :CFBundleIconFile string SlideStudio' "$STUDIO_APP/Contents/Info.plist"
fi
chmod +x "$STUDIO_APP/Contents/MacOS/SlideStudio" "$STUDIO_APP/Contents/Resources/runtime/node"
codesign --force --sign - "$STUDIO_APP/Contents/Resources/runtime/node"
codesign --force --sign - "$STUDIO_APP"
codesign --verify --deep --strict "$STUDIO_APP"
"$STUDIO_APP/Contents/MacOS/SlideStudio" --self-test
printf 'Built %s\n' "$STUDIO_APP"
