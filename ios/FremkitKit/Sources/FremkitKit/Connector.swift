import Foundation

public enum ConnectResult: Equatable, Sendable {
    /// `host` is the candidate that answered: store it with `PairedMac.updating(address:)`.
    case connected(host: String, info: DeviceInfo)
    case unauthorized
    /// Nobody answered with the right key and at least one answered with another: the Mac's
    /// certificate was reset, or another machine holds its address.
    case keyChanged
    case unreachable
}

/// Finds the paired Mac when it may have moved: its `.local` name, then the last address that
/// worked, then whatever Bonjour resolved. A wrong key is "not this one, next" (remembered: if
/// nothing else answers, the key changed); a 401 from the right key ends the search, since
/// another address would only say the same.
public struct Connector: Sendable {
    public let prober: any Prober

    public init(prober: any Prober = HTTPProber()) {
        self.prober = prober
    }

    public func connect(mac: PairedMac, discovered: [String]) async -> ConnectResult {
        var sawWrongKey = false
        for host in Self.candidates(mac: mac, discovered: discovered) {
            switch await prober.probe(host: host, port: mac.port, mac: mac) {
            case let .ok(info): return .connected(host: host, info: info)
            case .unauthorized: return .unauthorized
            case .pinMismatch: sawWrongKey = true
            case .unreachable: continue
            }
        }
        return sawWrongKey ? .keyChanged : .unreachable
    }

    /// `mac.host`, `mac.address`, then `discovered`, each once (compared without case).
    static func candidates(mac: PairedMac, discovered: [String]) -> [String] {
        var seen = Set<String>()
        return ([mac.host, mac.address] + discovered).filter { host in
            !host.isEmpty && seen.insert(PinnedSession.normalise(host)).inserted
        }
    }
}
