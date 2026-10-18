import Cocoa
@preconcurrency import WebKit
import UniformTypeIdentifiers

@main
struct SlideStudioMain {
    static func main() {
        if CommandLine.arguments.contains("--self-test") {
            let base = Bundle.main.resourceURL!.appendingPathComponent("studio")
            let ok = FileManager.default.isExecutableFile(atPath: Bundle.main.resourceURL!.appendingPathComponent("runtime/node").path) && FileManager.default.fileExists(atPath: base.appendingPathComponent("server.mjs").path)
            print(ok ? "Slide Studio bundle: OK" : "Slide Studio bundle: missing resources")
            exit(ok ? 0 : 1)
        }
        let app = NSApplication.shared
        let delegate = StudioApp()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        app.run()
        withExtendedLifetime(delegate) {}
    }
}

final class StudioApp: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandlerWithReply {
    var window: NSWindow!
    var webView: WKWebView!
    var service: Process?
    var servicePipe: Pipe?
    var serviceBuffer = Data()
    var localPort = 0
    let token = UUID().uuidString + UUID().uuidString
    var allowQuit = false
    var ready = false
    var pendingFiles: [URL] = []
    var extraWindows: [NSWindow] = []
    var printView: WKWebView?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // A single editor process owns the last-workspace draft.
        if let id = Bundle.main.bundleIdentifier,
           let existing = NSRunningApplication.runningApplications(withBundleIdentifier: id).first(where: { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }) {
            existing.activate(options: [.activateAllWindows])
            NSApplication.shared.terminate(nil)
            return
        }
        setupMenu()
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 940), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Slide Studio"
        window.minSize = NSSize(width: 1060, height: 680)
        window.delegate = self
        window.center()
        let message = NSTextField(labelWithString: "Slide Studioを起動しています…")
        message.alignment = .center
        message.frame = NSRect(x: 0, y: 440, width: 1440, height: 40)
        window.contentView?.addSubview(message)
        window.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
        startService()
    }

    func setupMenu() {
        let menu = NSMenu()
        let appMenu = NSMenu()
        let appRoot = NSMenuItem(); appRoot.submenu = appMenu; menu.addItem(appRoot)
        appMenu.addItem(withTitle: "Slide Studioについて", action: #selector(showAbout), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Slide Studioを終了", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let files = NSMenu(title: "ファイル"), fileRoot = NSMenuItem(title: "ファイル", action: nil, keyEquivalent: ""); fileRoot.submenu = files; menu.addItem(fileRoot)
        files.addItem(withTitle: "保存一覧", action: #selector(showGallery), keyEquivalent: "l")
        files.addItem(withTitle: "新しい発表", action: #selector(newProject), keyEquivalent: "n")
        files.addItem(withTitle: ".slideを開く…", action: #selector(openProject), keyEquivalent: "o")
        files.addItem(withTitle: "保存一覧へ保存", action: #selector(saveProject), keyEquivalent: "s")
        let copy = files.addItem(withTitle: "別名で保存", action: #selector(saveCopy), keyEquivalent: "s"); copy.keyEquivalentModifierMask = [.command, .shift]
        files.addItem(.separator())
        files.addItem(withTitle: "保存フォルダを表示", action: #selector(revealData), keyEquivalent: "")
        files.addItem(withTitle: "印刷…", action: #selector(printPage), keyEquivalent: "p")
        let edit = NSMenu(title: "編集"), editRoot = NSMenuItem(title: "編集", action: nil, keyEquivalent: ""); editRoot.submenu = edit; menu.addItem(editRoot)
        for (title, selector, key) in [("元に戻す", Selector(("undo:")), "z"), ("切り取り", #selector(NSText.cut(_:)), "x"), ("コピー", #selector(NSText.copy(_:)), "c"), ("貼り付け", #selector(NSText.paste(_:)), "v"), ("すべて選択", #selector(NSText.selectAll(_:)), "a")] { edit.addItem(withTitle: title, action: selector, keyEquivalent: key) }
        NSApplication.shared.mainMenu = menu
    }

    var dataDirectory: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Slide Studio", isDirectory: true)
    }

    func startService() {
        do {
            try FileManager.default.createDirectory(at: dataDirectory, withIntermediateDirectories: true)
            let resources = Bundle.main.resourceURL!
            let process = Process(), pipe = Pipe()
            process.executableURL = resources.appendingPathComponent("runtime/node")
            process.arguments = [resources.appendingPathComponent("studio/server.mjs").path]
            process.currentDirectoryURL = dataDirectory
            var env = ProcessInfo.processInfo.environment
            env["SLIDE_STUDIO_DATA_DIR"] = dataDirectory.path
            env["SLIDE_STUDIO_PORT"] = "0"
            env["SLIDE_STUDIO_TOKEN"] = token
            env["SLIDE_STUDIO_DESKTOP"] = "1"
            env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:" + (env["PATH"] ?? "")
            env.removeValue(forKey: "OPENAI_API_KEY")
            process.environment = env
            process.standardOutput = pipe
            // Never display Codex stderr or credentials in an error dialog.
            process.standardError = FileHandle.nullDevice
            service = process; servicePipe = pipe
            pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
                let bytes = handle.availableData
                guard !bytes.isEmpty else { return }
                DispatchQueue.main.async {
                    guard let self = self else { return }
                    self.serviceBuffer.append(bytes)
                    while let newline = self.serviceBuffer.firstIndex(of: 10) {
                        let line = String(data: self.serviceBuffer.prefix(upTo: newline), encoding: .utf8) ?? ""
                        self.serviceBuffer.removeSubrange(...newline)
                        if line.hasPrefix("SLIDE_STUDIO_READY "), let data = line.dropFirst("SLIDE_STUDIO_READY ".count).data(using: .utf8), let info = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let port = info["port"] as? Int {
                            self.localPort = port
                            self.openEditor()
                        }
                    }
                }
            }
            process.terminationHandler = { [weak self] _ in DispatchQueue.main.async { if let self = self, !self.allowQuit { self.showError("ローカルサービスが終了しました。アプリを終了して開き直してください。保存済みのファイルは保持されています。") } } }
            try process.run()
            DispatchQueue.main.asyncAfter(deadline: .now() + 20) { [weak self] in if let self = self, !self.ready { self.showError("起動が完了しませんでした。アプリを開き直してください。") } }
        } catch { showError("起動できませんでした: \(error.localizedDescription)") }
    }

    func openEditor() {
        guard !ready else { return }; ready = true
        let config = WKWebViewConfiguration()
        config.mediaTypesRequiringUserActionForPlayback = []
        config.preferences.javaScriptCanOpenWindowsAutomatically = true
        let values: [String: Any] = ["token": token, "port": localPort]
        let data = try! JSONSerialization.data(withJSONObject: values)
        let injected = "globalThis.STUDIO_DESKTOP=" + String(data: data, encoding: .utf8)! + ";"
        config.userContentController.addUserScript(WKUserScript(source: injected, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "studio")
        webView = WKWebView(frame: window.contentView!.bounds, configuration: config)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self; webView.uiDelegate = self
        if #available(macOS 13.3, *) { webView.isInspectable = true }
        window.contentView = webView
        webView.load(URLRequest(url: URL(string: "http://127.0.0.1:\(localPort)/")!))
    }

    func trusted(_ url: URL?) -> Bool { url?.scheme == "http" && url?.host == "127.0.0.1" && url?.port == localPort }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        guard message.frameInfo.isMainFrame, trusted(message.frameInfo.request.url), let value = message.body as? [String: Any], let action = value["action"] as? String else { replyHandler(nil, "許可されていない操作です。"); return }
        switch action {
        case "save":
            guard let name = value["name"] as? String, let encoded = value["data"] as? String, let data = Data(base64Encoded: encoded) else { replyHandler(nil, "書き出す内容が不正です。"); return }
            let panel = NSSavePanel(); panel.nameFieldStringValue = URL(fileURLWithPath: name).lastPathComponent; panel.canCreateDirectories = true
            panel.beginSheetModal(for: window) { result in
                guard result == .OK, let url = panel.url else { replyHandler(["cancelled": true], nil); return }
                do { try data.write(to: url, options: .atomic); replyHandler(["saved": true], nil) } catch { replyHandler(nil, error.localizedDescription) }
            }
        case "fullscreen":
            if let enabled = value["enabled"] as? Bool, window.styleMask.contains(.fullScreen) != enabled { window.toggleFullScreen(nil) }
            replyHandler(["ok": true], nil)
        case "printHTML":
            guard let html = value["html"] as? String else { replyHandler(nil, "印刷内容が不正です。"); return }
            let view = WKWebView(frame: NSRect(x:0,y:0,width:1209,height:680))
            view.navigationDelegate = self
            printView = view
            view.loadHTMLString(html, baseURL: URL(string: "http://127.0.0.1:\(localPort)/"))
            replyHandler(["ok": true], nil)
        case "print": printPage(); replyHandler(["ok": true], nil)
        case "closeReady": allowQuit = true; replyHandler(["ok": true], nil); NSApplication.shared.terminate(nil)
        default: replyHandler(nil, "未対応の操作です。")
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        // Media embeds are unprivileged subframes. Main-frame navigation stays local.
        if navigationAction.targetFrame?.isMainFrame == false { decisionHandler(.allow); return }
        if trusted(url) || url.absoluteString == "about:blank" { decisionHandler(.allow) }
        else { if ["https", "http"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }; decisionHandler(.cancel) }
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard trusted(navigationAction.request.url) else { if let url = navigationAction.request.url, ["https", "http"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }; return nil }
        let child = WKWebView(frame: NSRect(x: 0, y: 0, width: 1280, height: 800), configuration: configuration)
        child.navigationDelegate = self; child.uiDelegate = self
        let other = NSWindow(contentRect: child.frame, styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
        other.title = "Slide Studio — 発表者画面"; other.contentView = child; other.isReleasedWhenClosed = false; other.makeKeyAndOrderFront(nil); extraWindows.append(other); return child
    }
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel(); panel.allowsMultipleSelection = parameters.allowsMultipleSelection; panel.canChooseDirectories = false
        panel.beginSheetModal(for: window) { response in completionHandler(response == .OK ? panel.urls : nil) }
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if webView === printView {
            let info = NSPrintInfo.shared.copy() as! NSPrintInfo
            info.paperSize = NSSize(width: 320 * 72 / 25.4, height: 180 * 72 / 25.4)
            info.topMargin = 0; info.bottomMargin = 0; info.leftMargin = 0; info.rightMargin = 0
            webView.printOperation(with: info).runModal(for: window, delegate: nil, didRun: nil, contextInfo: nil)
            return
        }
        guard trusted(webView.url), webView === self.webView else { return }
        if !pendingFiles.isEmpty { let files = pendingFiles; pendingFiles = []; for file in files { loadProject(file) } }
    }
    func runAction(_ name: String) { guard ready else { return }; webView?.evaluateJavaScript("Promise.resolve(actions['\(name)']?.()).catch(e=>toast(e.message));", completionHandler: nil) }
    @objc func showGallery() { runAction("saved-gallery") }
    @objc func newProject() { runAction("new-project") }
    @objc func saveProject() { runAction("save-project-gallery") }
    @objc func saveCopy() { runAction("save-project-copy") }
    @objc func revealData() { NSWorkspace.shared.open(dataDirectory.appendingPathComponent("saved-presentations")) }
    @objc func printPage() { webView?.printOperation(with: NSPrintInfo.shared).runModal(for: window, delegate: nil, didRun: nil, contextInfo: nil) }
    @objc func showAbout() { NSApplication.shared.orderFrontStandardAboutPanel(options: [.applicationName: "Slide Studio", .applicationVersion: "4.0.0", .credits: NSAttributedString(string: "スライド制作・素材・Codexをひとつのワークスペースに。")]) }
    @objc func openProject() {
        let panel = NSOpenPanel(); panel.allowedContentTypes = [UTType(filenameExtension: "slide") ?? .data, .json, .plainText]; panel.allowsMultipleSelection = false
        panel.beginSheetModal(for: window) { result in if result == .OK, let file = panel.url { self.loadProject(file) } }
    }
    func loadProject(_ url: URL) {
        do {
            let text = try String(contentsOf: url, encoding: .utf8)
            webView.callAsyncJavaScript("if(!globalThis.studioOpenFile)throw Error('起動中です。もう一度ファイルを開いてください。');await studioOpenFile(name,text);", arguments: ["name": url.lastPathComponent, "text": text], in: nil, in: .page) { result in if case .failure(let error) = result { self.showError(error.localizedDescription) } }
        } catch { showError(error.localizedDescription) }
    }
    func application(_ sender: NSApplication, openFiles filenames: [String]) { for name in filenames { let url = URL(fileURLWithPath: name); if webView?.isLoading == false { loadProject(url) } else { pendingFiles.append(url) } }; sender.reply(toOpenOrPrint: .success) }
    func windowShouldClose(_ sender: NSWindow) -> Bool { if sender === window { NSApplication.shared.terminate(nil); return false }; return true }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if allowQuit || !ready { return .terminateNow }
        webView.evaluateJavaScript("if(globalThis.studioSaveAndClose){studioSaveAndClose();}else{window.webkit.messageHandlers.studio.postMessage({action:'closeReady'});}", completionHandler: { _, error in if error != nil { self.showError("作業状態を保存できません。ファイルに書き出してから終了してください。") } })
        return .terminateCancel
    }
    func applicationWillTerminate(_ notification: Notification) { allowQuit = true; servicePipe?.fileHandleForReading.readabilityHandler = nil; service?.terminate() }
    func showError(_ text: String) { let alert = NSAlert(); alert.messageText = "Slide Studio"; alert.informativeText = text; alert.alertStyle = .warning; alert.runModal() }
}
