import Foundation
import Security

/// The Mac this iPad is paired with, and the token that proves it.
public struct PairedMac: Codable, Equatable, Sendable {
    /// The Mac's `.local` name.
    public var host: String
    /// The last address that answered, usually an IP literal.
    public var address: String
    public var port: Int
    /// The pin, base64url SHA-256 of the Mac's SPKI.
    public var keyHash: String
    /// The device token, sent as the `fremkit_device` cookie. Never logged.
    public var token: String
    public var deviceId: String
    /// The Mac's name for people: its `.local` name without the suffix, or its Bonjour name.
    public var name: String

    public init(host: String, address: String, port: Int, keyHash: String, token: String, deviceId: String, name: String) {
        self.host = host
        self.address = address
        self.port = port
        self.keyHash = keyHash
        self.token = token
        self.deviceId = deviceId
        self.name = name
    }

    /// The record with `address` as the one to try first next time, when it is an IP literal (the
    /// Mac moved). A name that answered changes nothing: `host` already is that name.
    public func updating(address: String) -> PairedMac {
        guard isIPLiteral(address) else { return self }
        var copy = self
        copy.address = address
        return copy
    }
}

/// Printing a pairing never shows its token or its pin.
extension PairedMac: CustomStringConvertible, CustomDebugStringConvertible {
    public var description: String { "PairedMac(\(name), \(host), \(address):\(port), device \(deviceId))" }
    public var debugDescription: String { description }
}

public protocol CredentialStore: Sendable {
    func load() -> PairedMac?
    func save(_ mac: PairedMac) throws
    func clear()
}

public struct KeychainError: Error, Equatable {
    public let status: OSStatus
}

/// The pairing in the keychain, as one generic password holding the record's JSON, readable after
/// the first unlock and never leaving this device (no iCloud keychain, no backup restore elsewhere).
public struct KeychainCredentialStore: CredentialStore {
    private let service: String
    private let account = "paired-mac"

    public init(service: String = "fremkit.pairing") {
        self.service = service
    }

    private var query: [CFString: Any] {
        [kSecClass: kSecClassGenericPassword,
         kSecAttrService: service,
         kSecAttrAccount: account,
         kSecUseDataProtectionKeychain: true]
    }

    public func load() -> PairedMac? {
        var lookup = query
        lookup[kSecReturnData] = true
        lookup[kSecMatchLimit] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(lookup as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return try? JSONDecoder().decode(PairedMac.self, from: data)
    }

    public func save(_ mac: PairedMac) throws {
        let data = try JSONEncoder().encode(mac)
        SecItemDelete(query as CFDictionary)
        var item = query
        item[kSecValueData] = data
        item[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(item as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }

    public func clear() {
        SecItemDelete(query as CFDictionary)
    }
}

/// A store in memory, for tests and previews. Its one value is behind a lock, hence
/// `@unchecked Sendable`.
public final class MemoryCredentialStore: CredentialStore, @unchecked Sendable {
    private let lock = NSLock()
    private var stored: PairedMac?

    public init(_ mac: PairedMac? = nil) {
        stored = mac
    }

    public func load() -> PairedMac? { lock.withLock { stored } }
    public func save(_ mac: PairedMac) throws { lock.withLock { stored = mac } }
    public func clear() { lock.withLock { stored = nil } }
}
