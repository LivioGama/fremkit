import SwiftUI

/// Not paired yet. Scanning and typing the code arrive with pairing; the buttons are here so
/// the screen has its final shape.
struct WelcomeView: View {
    let credentialsUnreadable: Bool

    var body: some View {
        VStack(spacing: 28) {
            Text(verbatim: "Fremkit")
                .font(.system(size: 56, weight: .bold))
            Text("Show your Mac’s Fremkit dashboard on this iPad.")
                .font(.title3)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            HStack(spacing: 16) {
                Button {} label: {
                    Label("Scan the code", systemImage: "qrcode.viewfinder")
                        .frame(minWidth: 200, minHeight: 44)
                }
                .buttonStyle(.borderedProminent)
                Button {} label: {
                    Label("Enter the code", systemImage: "keyboard")
                        .frame(minWidth: 200, minHeight: 44)
                }
                .buttonStyle(.bordered)
            }
            .controlSize(.large)
            .disabled(true)
            if credentialsUnreadable {
                Text("The saved pairing could not be read. Pairing again replaces it.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
        }
        .padding(40)
        .frame(maxWidth: 640)
    }
}
