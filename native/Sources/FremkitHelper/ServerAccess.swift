import Foundation
import FremkitCore

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
     A one-time link that signs a browser or a web view in and lands on `target`, or nil when the
     server would not mint one. `done` runs on the main thread.

     Following it opens a session on the server, whose cookie is what the page then carries: the
     cookie never holds the secret itself (browsers hand a host's cookies to every port on it),
     and neither does the URL (it would sit in a browser's history). The code works once, within
     a minute. The kiosk and the admin window sign in this way too.
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
