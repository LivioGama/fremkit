import CoreGraphics
import Foundation

/// Reads TouchRemap's selected screen as a read-only preference for this local ILITEK trial.
/// Fremkit never writes this file, and it does not activate TouchRemap's currently-disabled
/// calibration settings.
enum ILITEKDisplayTarget {
    private struct TouchRemapPreference: Decodable {
        let lastScreen: String?
    }

    static func bounds() -> CGRect? {
        guard let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
            return nil
        }
        let url = support.appendingPathComponent("pd-touchbase/remap_config.json")
        guard let data = try? Data(contentsOf: url),
              let preference = try? JSONDecoder().decode(TouchRemapPreference.self, from: data),
              let key = preference.lastScreen,
              key.hasPrefix("id:"),
              let rawID = UInt32(key.dropFirst(3)) else { return nil }
        let displayID = CGDirectDisplayID(rawID)
        guard CGDisplayIsActive(displayID) != 0 else { return nil }
        let frame = CGDisplayBounds(displayID)
        guard frame.width > 0, frame.height > 0 else { return nil }
        return frame
    }
}
