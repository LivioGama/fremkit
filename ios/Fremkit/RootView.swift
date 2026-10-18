import FremkitKit
import SwiftUI

/// One screen per `AppState`, and the app-wide reactions: back from the background, and the
/// unreachable screen's retries.
struct RootView: View {
    let model: AppModel
    @Environment(\.scenePhase) private var scenePhase
    @State private var wasInBackground = false

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            screen
        }
        .preferredColorScheme(.dark)
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

    @ViewBuilder private var screen: some View {
        switch model.state {
        case .welcome:
            WelcomeView(credentialsUnreadable: model.credentialsUnreadable)
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

/// The dashboard full screen: no status bar, the home indicator hidden, the screen kept awake,
/// the page inside the safe area.
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
            .statusBarHidden(true)
            .persistentSystemOverlays(.hidden)
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
