import FremkitKit
import SwiftUI

@main
struct FremkitApp: App {
    @State private var network: LocalNetwork
    @State private var model: AppModel
    @State private var launched = false

    init() {
        let network = LocalNetwork()
        _network = State(initialValue: network)
        _model = State(initialValue: AppModel(store: KeychainCredentialStore(), discovered: { network.addresses }))
    }

    var body: some Scene {
        WindowGroup {
            RootView(model: model)
                .task { launch() }
        }
    }

    private func launch() {
        guard !launched else { return }
        launched = true
        let model = model
        // A newly resolved Bonjour address or the network coming back is a reason to try again
        // right away rather than at the next 5 s tick.
        network.onChange = {
            if case .unreachable = model.state { model.reconnect() }
        }
        // Browsing is also what asks for Local Network access, the first time.
        network.start()
        model.start()
        #if DEBUG
        Task { await model.seedFromLaunchArgument() }
        #endif
    }
}
