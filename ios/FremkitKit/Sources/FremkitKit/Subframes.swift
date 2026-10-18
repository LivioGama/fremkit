import Foundation

extension Dashboard {
    /// Whether a frame inside the dashboard, never the page itself, may load `url`.
    ///
    /// The dashboard's only frames are its widgets, each loaded from `/widgets/<id>/…` on the Mac
    /// that serves the page (and a widget's own CSP forbids frames of its own). So a frame may go
    /// to that host and port, over HTTPS, under `/widgets/` and nowhere else: not to another site,
    /// not to the dashboard's own page or API, not to `about:` or `data:` — the same rule the Mac's
    /// kiosk applies. The path is judged decoded, so an encoded dot segment cannot climb out.
    public static func allowsSubframe(_ url: URL?, host: String, port: Int) -> Bool {
        guard let url,
              url.scheme?.lowercased() == "https",
              url.user == nil, url.password == nil,
              let urlHost = url.host(percentEncoded: false), !urlHost.isEmpty,
              PinnedSession.normalise(urlHost) == PinnedSession.normalise(host),
              (url.port ?? 443) == port else { return false }
        let path = url.path(percentEncoded: false)
        guard path.hasPrefix("/widgets/"), !path.contains("\\") else { return false }
        return !path.split(separator: "/", omittingEmptySubsequences: false).contains { $0 == "." || $0 == ".." }
    }
}
