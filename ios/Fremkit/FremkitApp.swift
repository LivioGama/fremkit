import FremkitKit
import SwiftUI

@main
struct FremkitApp: App {
    @State private var network: LocalNetwork
    @State private var model: AppModel
    @State private var flow: PairingFlow
    @State private var launched = false
    private let meter: ViewportMeter

    init() {
        let network = LocalNetwork()
        let meter = ViewportMeter()
        let model = AppModel(store: KeychainCredentialStore(), discovered: {
            network.refresh()
            return network.addresses
        })
        _network = State(initialValue: network)
        _model = State(initialValue: model)
        _flow = State(initialValue: PairingFlow.live(model: model, meter: meter))
        self.meter = meter
    }

    var body: some Scene {
        WindowGroup {
            RootView(model: model, flow: flow, network: network, meter: meter)
                .task { launch() }
                // `fremkit://pair?…` from the Camera app or anywhere else. Anything that is not a
                // valid pairing link is ignored.
                .onOpenURL { url in flow.handle(url: url) }
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
        flow.seedFromLaunchArgument()
        #endif
    }
}
