// The app side of pairing: what the flow in FremkitKit needs from UIKit (this iPad's name, the size
// to report), the screen of a link being paired, and the wording of what can go wrong.
import FremkitKit
import SwiftUI
import UIKit

/// The size of the region `RootView` lays every screen out in, the dashboard's web view included,
/// as last measured. Pairing reports it, so the Mac's screen matches what the page will get.
@MainActor
final class ScreenMeter {
    var size: CGSize?

    /// What pairing reports: the measured region, or, before the first layout, the key window's
    /// safe area (the same region, computed instead of measured).
    var viewport: Viewport {
        Viewport(points: size ?? Self.windowSafeArea())
    }

    private static func windowSafeArea() -> CGSize {
        let window = UIApplication.shared.connectedScenes
            .compactMap { ($0 as? UIWindowScene)?.windows.first }
            .first
        guard let window else { return .zero }
        return window.bounds.inset(by: window.safeAreaInsets).size
    }
}

extension PairingFlow {
    /// The flow as the app runs it: the iPad's own name, the measured size, the real requests.
    static func live(model: AppModel, meter: ScreenMeter) -> PairingFlow {
        PairingFlow(model: model, deviceName: { UIDevice.current.name }, viewport: { meter.viewport })
    }
}

extension PairingProblem {
    /// The line shown under the button.
    var text: Text {
        switch self {
        case let .refused(message):
            // The Mac's own words, already in the Mac's language.
            message.isEmpty ? Text("The Mac refused the code.") : Text(verbatim: message)
        case .unreachable:
            Text("Can’t reach the Mac")
        case .wrongMac:
            Text("This is not the Mac that showed the code")
        case .invalidRequest:
            Text("The Mac did not accept the request. Update Fremkit on the Mac.")
        case .notSaved:
            Text("The pairing could not be saved on this iPad.")
        }
    }
}

/// A scanned or opened link being paired: it starts on its own; after a failure the reason shows
/// under **Try again**.
struct LinkPairingView: View {
    let flow: PairingFlow
    let link: PairingLink

    var body: some View {
        VStack(spacing: 20) {
            Image(systemName: "desktopcomputer")
                .font(.system(size: 56))
                .foregroundStyle(.tint)
            Text("Pairing with \(link.macName)")
                .font(.title.bold())
                .multilineTextAlignment(.center)
            if flow.problem == nil {
                ProgressView().controlSize(.large)
            } else {
                Button { flow.retry() } label: {
                    Text("Try again")
                        .frame(minWidth: 200, minHeight: 44)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(flow.isWorking)
            }
            ProblemLine(problem: flow.problem)
            Button("Cancel", role: .cancel) { flow.cancel() }
                .frame(minHeight: 44)
        }
        .padding(40)
        .frame(maxWidth: 640)
    }
}

/// The reason the last request failed, or nothing.
struct ProblemLine: View {
    let problem: PairingProblem?

    var body: some View {
        if let problem {
            problem.text
                .foregroundStyle(.red)
                .multilineTextAlignment(.center)
        }
    }
}
