import Network
import Observation

/// The Macs advertising `_fremkit._tcp` on the local network, each resolved to the address it
/// answered from, and whether the network is up.
@Observable @MainActor
final class LocalNetwork {
    /// Resolved addresses by Bonjour service name (the Mac's computer name).
    private(set) var services: [String: String] = [:]

    /// Every resolved address, in a stable order: the `discovered` candidates of `Connector`.
    var addresses: [String] { services.keys.sorted().compactMap { services[$0] } }

    /// Called when an address is newly resolved or the network becomes usable again.
    @ObservationIgnored var onChange: (@MainActor () -> Void)?

    @ObservationIgnored private var browser: NWBrowser?
    @ObservationIgnored private var monitor: NWPathMonitor?
    @ObservationIgnored private var results: [String: NWEndpoint] = [:]
    @ObservationIgnored private var resolving: [String: NWConnection] = [:]
    @ObservationIgnored private var online = true

    static let serviceType = "_fremkit._tcp"

    func start() {
        guard browser == nil else { return }
        let browser = NWBrowser(for: .bonjour(type: Self.serviceType, domain: nil), using: .tcp)
        browser.browseResultsChangedHandler = { [weak self] results, _ in
            MainActor.assumeIsolated { self?.update(results) }
        }
        browser.start(queue: .main)
        self.browser = browser

        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { [weak self] path in
            MainActor.assumeIsolated { self?.pathChanged(satisfied: path.status == .satisfied) }
        }
        monitor.start(queue: .main)
        self.monitor = monitor
    }

    private func update(_ found: Set<NWBrowser.Result>) {
        var current: [String: NWEndpoint] = [:]
        for result in found {
            if case let .service(name, _, _, _) = result.endpoint { current[name] = result.endpoint }
        }
        for name in results.keys where current[name] == nil {
            services[name] = nil
            resolving.removeValue(forKey: name)?.cancel()
        }
        results = current
        for (name, endpoint) in current where services[name] == nil {
            resolve(name, endpoint)
        }
    }

    private func pathChanged(satisfied: Bool) {
        defer { online = satisfied }
        guard satisfied, !online else { return }
        // Back on a network, perhaps another one: the old addresses may be stale.
        services = [:]
        for (name, endpoint) in results { resolve(name, endpoint) }
        onChange?()
    }

    /// Opens a TCP connection to the service just to learn which address answers, then closes it.
    private func resolve(_ name: String, _ endpoint: NWEndpoint) {
        guard resolving[name] == nil else { return }
        let connection = NWConnection(to: endpoint, using: .tcp)
        resolving[name] = connection
        connection.stateUpdateHandler = { [weak self, weak connection] state in
            MainActor.assumeIsolated {
                guard let self, let connection else { return }
                switch state {
                case .ready:
                    let address = connection.currentPath?.remoteEndpoint.flatMap(Self.host(of:))
                    self.finishResolving(name, connection, address: address)
                case .failed, .waiting, .cancelled:
                    self.finishResolving(name, connection, address: nil)
                default:
                    break
                }
            }
        }
        connection.start(queue: .main)
    }

    private func finishResolving(_ name: String, _ connection: NWConnection, address: String?) {
        connection.stateUpdateHandler = nil
        connection.cancel()
        guard resolving[name] === connection else { return }
        resolving[name] = nil
        guard let address, results[name] != nil, services[name] != address else { return }
        services[name] = address
        onChange?()
    }

    /// An address as `Connector` takes it: an IP literal (IPv6 with its zone) or a name.
    nonisolated static func host(of endpoint: NWEndpoint) -> String? {
        guard case let .hostPort(host, _) = endpoint else { return nil }
        switch host {
        case let .ipv4(address): return "\(address)"
        case let .ipv6(address): return "\(address)"
        case let .name(name, _): return name
        @unknown default: return nil
        }
    }
}
