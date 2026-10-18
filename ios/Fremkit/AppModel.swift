// The app's state machine is `AppModel` in FremkitKit, where it is unit-tested. What lives here
// needs UIKit.
import FremkitKit
import UIKit

#if DEBUG
extension AppModel {
    /// Debug builds only: `-FremkitSeedLink 'fremkit://pair?…'` on the launch command line pairs
    /// with that link's code, as scanning it would, so a development install needs no camera and
    /// no token in any file. Release builds do not contain this.
    func seedFromLaunchArgument() async {
        guard let text = UserDefaults.standard.string(forKey: "FremkitSeedLink") else { return }
        guard let url = URL(string: text), let link = PairingLink(url: url) else {
            print("Fremkit: -FremkitSeedLink is not a pairing link")
            return
        }
        do {
            let paired = try await PairClient().pair(hosts: [link.host, link.address], port: link.port,
                                                     keyHash: link.keyHash, code: link.code,
                                                     name: UIDevice.current.name, viewport: Self.currentViewport(),
                                                     macName: link.macName)
            try pair(with: paired)
        } catch {
            // PairError carries the server's message at most, KeychainError a status: no secret.
            print("Fremkit: seed pairing failed: \(error)")
        }
    }

    /// The window's size inside the safe area, in points: what the web view gets.
    static func currentViewport() -> Viewport {
        let window = UIApplication.shared.connectedScenes
            .compactMap { ($0 as? UIWindowScene)?.windows.first }
            .first
        guard let window else { return Viewport(width: 1, height: 1) }
        let size = window.bounds.inset(by: window.safeAreaInsets).size
        return Viewport(width: Int(size.width.rounded()), height: Int(size.height.rounded()))
    }
}
#endif
