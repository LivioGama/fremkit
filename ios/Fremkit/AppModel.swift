// The app's state machine is `AppModel` in FremkitKit, where it is unit-tested, and so is pairing
// (`PairingFlow`). What lives here is for development builds only.
import FremkitKit
import Foundation

#if DEBUG
extension PairingFlow {
    /// Debug builds only: `-FremkitSeedLink 'fremkit://pair?…'` on the launch command line opens
    /// that link as the Camera app would, so a development install can pair without the camera
    /// and with no token in any file. Release builds do not contain this.
    func seedFromLaunchArgument() {
        guard let text = UserDefaults.standard.string(forKey: "FremkitSeedLink") else { return }
        guard let url = URL(string: text), handle(url: url) else {
            print("Fremkit: -FremkitSeedLink is not a pairing link")
            return
        }
    }
}
#endif
