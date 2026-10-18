import FremkitKit
import SwiftUI

/// One screen per `AppState`, or the pairing screen while pairing runs, and the app-wide
/// reactions: back from the background, the unreachable screen's retries, a link that would
/// replace the pairing.
///
/// Every screen is laid out in the same region: the safe area with the status bar and the home
/// indicator hidden, the dashboard's web view included. That region is what pairing reports as
/// the viewport (`ViewportMeter`), so it is measured here, on the container itself.
struct RootView: View {
    let model: AppModel
    let flow: PairingFlow
    let network: LocalNetwork
    let meter: ViewportMeter
    @Environment(\.scenePhase) private var scenePhase
    @State private var wasInBackground = false

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            screen
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background {
                    // The keyboard of the code field shrinks the safe area; the dashboard never
                    // has it up when it loads, so it is left out of the measure.
                    Color.clear
                        .ignoresSafeArea(.keyboard)
                        .onGeometryChange(for: CGSize.self) { $0.size } action: { meter.measured($0) }
                }
        }
        .statusBarHidden(true)
        .persistentSystemOverlays(.hidden)
        .preferredColorScheme(.dark)
        .alert(replaceTitle, isPresented: replacing, presenting: flow.pendingLink) { _ in
            Button("Replace", role: .destructive) { flow.confirmReplace() }
            Button("Cancel", role: .cancel) { flow.declineReplace() }
        } message: { link in
            Text("This iPad will show the dashboard of \(link.macName) instead.")
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .background:
                wasInBackground = true
            case .active where wasInBackground:
                wasInBackground = false
                model.resume()
            default:
                break
            }
        }
    }

    /// Shown while a link waits for the user to agree to replace the pairing. Dismissal goes
    /// through the alert's buttons, which clear the link themselves.
    private var replacing: Binding<Bool> {
        Binding(get: { flow.pendingLink != nil }, set: { _ in })
    }

    private var replaceTitle: Text {
        Text("Replace the pairing with \(model.mac?.name ?? "")?")
    }

    @ViewBuilder private var screen: some View {
        switch flow.step {
        case .idle:
            appScreen
        case .scanning:
            ScannerView(flow: flow)
        case let .link(link):
            LinkPairingView(flow: flow, link: link)
        case .manualList, .manualKey, .manualCode:
            ManualPairView(flow: flow, network: network)
        }
    }

    @ViewBuilder private var appScreen: some View {
        switch model.state {
        case .welcome:
            WelcomeView(credentialsUnreadable: model.credentialsUnreadable,
                        scan: { flow.scan() }, enterCode: { flow.enterCode() })
        case .connecting:
            ConnectingView(name: model.mac?.name)
        case let .dashboard(host, _):
            if let mac = model.mac {
                DashboardScreen(host: host, mac: mac, model: model)
                    .id(host)
            }
        case let .unreachable(name):
            UnreachableView(name: name, isRetrying: model.isConnecting) { model.reconnect() }
                .task {
                    // Every 5 s while the screen is up; the task ends with the screen.
                    while !Task.isCancelled {
                        try? await Task.sleep(for: .seconds(5))
                        if Task.isCancelled { break }
                        model.reconnect()
                    }
                }
        case .unauthorized:
            UnauthorizedView { model.forget() }
        }
    }
}

/// The dashboard: the screen kept awake, the page inside the safe area (the status bar and the
/// home indicator are hidden by `RootView` on every screen).
private struct DashboardScreen: View {
    let host: String
    let mac: PairedMac
    let model: AppModel

    var body: some View {
        DashboardView(host: host, port: mac.port, mac: mac,
                      onMessage: { message in
                          if message == .unauthorized { model.pageSaidUnauthorized() }
                          // `screen` and `brightness` are for later: brightness is the iPad's next step.
                      },
                      onFailure: { model.dashboardFailed() })
            .onAppear { UIApplication.shared.isIdleTimerDisabled = true }
            .onDisappear { UIApplication.shared.isIdleTimerDisabled = false }
    }
}

private struct ConnectingView: View {
    let name: String?

    var body: some View {
        VStack(spacing: 16) {
            ProgressView().controlSize(.large)
            if let name {
                Text("Connecting to \(name)…")
            } else {
                Text("Connecting…")
            }
        }
        .foregroundStyle(.secondary)
    }
}
