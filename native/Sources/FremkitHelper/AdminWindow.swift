import AppKit
import Foundation
import UniformTypeIdentifiers
import FremkitCore
import WebKit

/// Web view with WebKit's native context menu removed; everything else is stock.
private final class AdminNoMenuWebView: WKWebView {
    override func willOpenMenu(_ menu: NSMenu, with event: NSEvent) {
        menu.removeAllItems()
    }
}

/// Ordinary titled window showing the admin UI, opened from the status menu.
///
/// One instance is kept for the lifetime of the helper: re-opening brings the existing window
/// forward instead of building a second one.
final class AdminWindow: NSObject, NSWindowDelegate, WKUIDelegate, WKNavigationDelegate, WKDownloadDelegate {
    private static let size = NSSize(width: 1280, height: 800)

    private var window: NSWindow?
    private var webView: WKWebView?
    private let url: URL
    /// Puts the server's cookie in the web view's store before a load.
    private let access: ServerAccess
    /// Set after a refused page was retried once with a fresh cookie, cleared by any other answer,
    /// so a server that keeps refusing shows its page instead of reloading for ever.
    private var retriedAfterRefusal = false
    /// The Edge display's frame in AppKit space, kept in step by the helper as displays come and
    /// go. The kiosk covers it above the status-bar level, so the admin must never sit there.
    var kioskFrame: NSRect?

    init(url: URL, access: ServerAccess) {
        self.url = url
        self.access = access
    }

    /// Shows the window, creating it on first use.
    func show() {
        // While the admin is open the helper behaves like a regular app (Dock icon, Cmd+Tab),
        // and an Edit menu gives the web view its standard key equivalents (Cmd+Z, Cmd+C…).
        NSApp.setActivationPolicy(.regular)
        installEditMenuIfNeeded()
        if let window {
            // Checked on every open, not only at creation: the window remembers its frame across
            // launches, so one drag onto the Edge — or a display rearrangement — would otherwise
            // park it under the kiosk for good, focused and invisible.
            rescueIfBuried(window)
            // Reopening a window that was hidden reloads it. The view is kept for the helper's
            // lifetime, so without this the admin shows whatever was built when it was first
            // opened — which after an upgrade means settings that exist in the code and not on
            // screen. A window already in front is left alone: that is a raise, not an open.
            if !window.isVisible { reloadAdmin() }
            NSApp.activate(ignoringOtherApps: true)
            window.makeKeyAndOrderFront(nil)
            return
        }

        let frame = centredFrame()
        let window = NSWindow(contentRect: frame,
                              styleMask: [.titled, .closable, .miniaturizable, .resizable],
                              backing: .buffered,
                              defer: false)
        window.title = L10n.string(.adminWindowTitle)
        window.isReleasedWhenClosed = false
        window.delegate = self
        // Remember size and position across launches; the centred frame is only the first-run default.
        window.setFrameAutosaveName("FremkitAdmin")

        // No context menu here either — the admin is a touch-first panel too — but text
        // interaction stays on: it has fields to type into and values to copy out.
        let webView = AdminNoMenuWebView(frame: NSRect(origin: .zero, size: frame.size))
        webView.allowsLinkPreview = false
        webView.autoresizingMask = [.width, .height]
        // Without a UI delegate a WKWebView silently ignores <input type="file">.
        webView.uiDelegate = self
        // Without a navigation delegate it silently drops downloads too: the backup is served as
        // an attachment, which WebKit neither shows nor saves on its own.
        webView.navigationDelegate = self
        window.contentView = webView
        access.installCookie(for: [url]) { [weak webView, url] in
            webView?.load(URLRequest(url: url))
        }

        self.window = window
        self.webView = webView

        // `setFrameAutosaveName` above restored whatever was saved, which may be the frame that
        // put this window under the kiosk in the first place.
        rescueIfBuried(window)

        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    /// Moves the window back onto a usable screen when its frame is not one. See `AdminPlacement`.
    private func rescueIfBuried(_ window: NSWindow) {
        let screens = NSScreen.screens.map(\.visibleFrame)
        guard let rescued = AdminPlacement.rescue(frame: window.frame,
                                                  size: Self.size,
                                                  screens: screens,
                                                  kiosk: kioskFrame) else { return }
        window.setFrame(rescued, display: false)
    }

    /// Centres the 1280x800 content rect on a screen the kiosk is not covering.
    private func centredFrame() -> NSRect {
        let screens = NSScreen.screens.map(\.visibleFrame)
        guard let screen = AdminPlacement.target(screens: screens, kiosk: kioskFrame)
            ?? NSScreen.main?.visibleFrame else {
            return NSRect(origin: .zero, size: Self.size)
        }
        return AdminPlacement.centred(size: Self.size, in: screen)
    }

    /// Reloads the admin page. Wired to Cmd+R and used when a hidden window is reopened.
    /// The cookie is written again first, from the token file: the server may have been restarted
    /// with another secret since the page was loaded.
    @objc func reloadAdmin() {
        access.installCookie(for: [url]) { [weak self] in
            guard let self, let webView = self.webView else { return }
            if webView.url == nil { webView.load(URLRequest(url: self.url)) } else { webView.reload() }
        }
    }

    // MARK: - WKUIDelegate

    /// Backs the page's file inputs (background images, the backup to restore) with the standard
    /// open panel. WebKit does not pass the input's `accept` list on macOS, so the panel offers
    /// the union of what the admin's inputs take; the server checks the file either way.
    func webView(_ webView: WKWebView,
                 runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.allowedContentTypes = [.png, .jpeg, .webP, .zip]
        guard let window else { completionHandler(nil); return }
        panel.beginSheetModal(for: window) { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }

    /// A link with `target="_blank"` asks for a new window, which the admin never opens: a site
    /// elsewhere goes to the default browser instead. Only a link the person clicked in the admin
    /// itself, never one from a widget's frame in the preview.
    func webView(_ webView: WKWebView,
                 createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        openInBrowserIfExternal(navigationAction)
        return nil
    }

    /// True, and the link opened in the default browser, when it is one the admin should not load.
    @discardableResult
    private func openInBrowserIfExternal(_ action: WKNavigationAction) -> Bool {
        guard action.navigationType == .linkActivated,
              action.sourceFrame.isMainFrame,
              let target = action.request.url,
              ExternalLink.opensInBrowser(target, from: url)
        else { return false }
        NSWorkspace.shared.open(target)
        return true
    }

    // MARK: - WKNavigationDelegate

    /// A plain link to another site would replace the admin, which has no back button: it opens
    /// in the default browser instead, and the admin stays where it was.
    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(openInBrowserIfExternal(navigationAction) ? .cancel : .allow)
    }

    /// Turns an attachment, or anything WebKit cannot display, into a download instead of a
    /// failed navigation. Main frame only: the widgets in the preview are sandboxed iframes and
    /// get nothing they did not get before.
    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        guard navigationResponse.isForMainFrame else { decisionHandler(.allow); return }
        if (navigationResponse.response as? HTTPURLResponse)?.statusCode == 401 {
            // Refused: show the server's page, and try once more with the cookie written again.
            decisionHandler(.allow)
            if !retriedAfterRefusal {
                retriedAfterRefusal = true
                reloadAdmin()
            }
            return
        }
        retriedAfterRefusal = false
        let disposition = (navigationResponse.response as? HTTPURLResponse)?
            .value(forHTTPHeaderField: "Content-Disposition") ?? ""
        let attachment = disposition.lowercased().hasPrefix("attachment")
        decisionHandler(attachment || !navigationResponse.canShowMIMEType ? .download : .allow)
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    // MARK: - WKDownloadDelegate

    /// Asks where to save, with the server's file name filled in. Cancelling the panel cancels
    /// the download.
    func download(_ download: WKDownload,
                  decideDestinationUsing response: URLResponse,
                  suggestedFilename: String,
                  completionHandler: @escaping (URL?) -> Void) {
        guard let window else { completionHandler(nil); return }
        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggestedFilename
        panel.directoryURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
        panel.beginSheetModal(for: window) { result in
            guard result == .OK, let url = panel.url else { completionHandler(nil); return }
            // The panel has already asked whether to replace it; WKDownload refuses to write over
            // an existing file, so the old one goes first.
            try? FileManager.default.removeItem(at: url)
            completionHandler(url)
        }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        NSLog("fremkit: admin download failed: \(error.localizedDescription)")
    }

    // MARK: - NSWindowDelegate

    // The window is only hidden by the close button; keeping it means the next "Open the admin"
    // is instant and does not reload the page.
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil)
        // Back to a menu-bar-only app once the admin is hidden.
        NSApp.setActivationPolicy(.accessory)
        return false
    }

    /// Builds the minimal main menu once: an application menu and an Edit menu whose standard
    /// selectors reach the first responder, i.e. the web view.
    private func installEditMenuIfNeeded() {
        guard NSApp.mainMenu == nil else { return }
        let main = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: L10n.string(.menuHideFremkit), action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: L10n.string(.menuQuitFremkit), action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)

        let editItem = NSMenuItem()
        let edit = NSMenu(title: L10n.string(.menuEdit))
        edit.addItem(withTitle: L10n.string(.menuUndo), action: Selector(("undo:")), keyEquivalent: "z")
        let redo = NSMenuItem(title: L10n.string(.menuRedo), action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(redo)
        edit.addItem(.separator())
        edit.addItem(withTitle: L10n.string(.menuCut), action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: L10n.string(.menuCopy), action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: L10n.string(.menuPaste), action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: L10n.string(.menuSelectAll), action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        main.addItem(editItem)

        let windowItem = NSMenuItem()
        let windowMenu = NSMenu(title: L10n.string(.menuWindow))
        windowMenu.addItem(withTitle: L10n.string(.menuClose), action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowMenu.addItem(withTitle: L10n.string(.menuMinimize), action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(.separator())
        // Cmd+R, because a web view with no chrome has no other way to be reloaded by hand. The
        // target is explicit: this object is not in the responder chain, so a nil target would
        // send the action up it and find nobody.
        let reload = NSMenuItem(title: L10n.string(.menuReload), action: #selector(reloadAdmin), keyEquivalent: "r")
        reload.target = self
        windowMenu.addItem(reload)
        windowItem.submenu = windowMenu
        main.addItem(windowItem)

        NSApp.mainMenu = main
    }
}
