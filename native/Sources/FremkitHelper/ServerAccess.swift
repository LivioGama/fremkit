import Foundation
import FremkitCore
import WebKit

/// The server's access secret, as the helper presents it (see `AccessToken` in FremkitCore).
///
/// One secret per helper launch, handed to every server the helper spawns, so a respawned server
/// keeps taking the kiosk's cookie. Which secret to *present* is read from the per-port token file
/// each time: that is ours when the server is ours, and the other one's when a `pnpm dev` holds
/// the port. Everything here runs on the main thread.
final class ServerAccess {
    /// This launch's secret, passed to the servers the helper spawns.
    let launchToken = AccessToken.generate()
    let port: Int
    private let file: URL

    init(port: Int) {
        self.port = port
        file = AccessToken.fileURL(port: port, supportDirectory: HelperPaths.supportDirectory())
    }

    /// The secret the server on the port holds, as far as the helper can tell.
    var current: String {
        AccessToken.read(from: file) ?? launchToken
    }

    /// Adds the bearer header to a request for the server.
    func authorize(_ request: inout URLRequest) {
        request.setValue(AccessToken.bearer(current), forHTTPHeaderField: "Authorization")
    }

    /**
     Writes the session cookie into the web views' shared store for each URL's host, then calls
     `done` on the main thread. Every web view the helper makes uses the default data store, so
     the kiosk and the admin window share it.

     The cookie is the one `/auth` would set, written directly: the helper holds the secret, so
     there is no one-time link to follow and no navigation to show.
     */
    func installCookie(for urls: [URL], done: @escaping () -> Void) {
        let token = current
        let store = WKWebsiteDataStore.default().httpCookieStore
        let cookies = urls.compactMap { AccessToken.cookie(token: token, port: port, for: $0) }
        let group = DispatchGroup()
        for cookie in cookies {
            group.enter()
            store.setCookie(cookie) { group.leave() }
        }
        group.notify(queue: .main, execute: done)
    }

    /**
     The server's diagnostics report (`GET /api/diagnostics`), already redacted by the server, or
     why there is none. `done` runs on the main thread.
     */
    func diagnostics(done: @escaping (HelperDiagnostics.ServerPart) -> Void) {
        guard let endpoint = URL(string: "http://127.0.0.1:\(port)/api/diagnostics") else {
            done(.unavailable(reason: "no address"))
            return
        }
        var request = URLRequest(url: endpoint)
        // The report reads the keychain and runs sw_vers and scutil: a few seconds at worst.
        request.timeoutInterval = 10
        authorize(&request)
        let session = URLSession(configuration: .ephemeral)
        session.dataTask(with: request) { data, response, error in
            let status = (response as? HTTPURLResponse)?.statusCode
            let text = data.flatMap { String(data: $0, encoding: .utf8) }
            let part: HelperDiagnostics.ServerPart
            if status == 200, let text, !text.isEmpty {
                part = .report(text)
            } else {
                part = .unavailable(reason: HelperDiagnostics.reason(status: status, error: error))
            }
            session.finishTasksAndInvalidate()
            DispatchQueue.main.async { done(part) }
        }.resume()
    }

    /**
     A one-time link that signs the default browser in and lands on `target`, or nil when the
     server would not mint one. `done` runs on the main thread.

     The browser has its own cookie jar that the helper cannot write, and the secret itself must
     not travel in a URL (it would sit in the browser's history), so the server is asked for a
     code that works once, within a minute.
     */
    func signInURL(for target: URL, done: @escaping (URL?) -> Void) {
        guard let endpoint = URL(string: "http://127.0.0.1:\(port)/api/auth/code") else {
            done(nil)
            return
        }
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.timeoutInterval = 5
        authorize(&request)
        let session = URLSession(configuration: .ephemeral)
        session.dataTask(with: request) { data, response, _ in
            let ok = (response as? HTTPURLResponse)?.statusCode == 200
            let url = ok ? AccessToken.code(fromResponse: data).flatMap { AccessToken.signInURL(for: target, code: $0) } : nil
            session.finishTasksAndInvalidate()
            DispatchQueue.main.async { done(url) }
        }.resume()
    }
}
