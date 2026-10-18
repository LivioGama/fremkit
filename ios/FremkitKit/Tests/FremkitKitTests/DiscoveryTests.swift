import XCTest
@testable import FremkitKit

final class DiscoveryTests: XCTestCase {
    func testReadsTheAddressAndPortOfTheTXTRecord() {
        XCTAssertEqual(FremkitTXT(["a": "192.0.2.10", "p": "4243"]), FremkitTXT(["a": "192.0.2.10"]))
        XCTAssertEqual(FremkitTXT(["a": "192.0.2.10", "p": "4302"])?.port, 4302)
        XCTAssertEqual(FremkitTXT(["a": "fe80::1%en0"])?.address, "fe80::1%en0")
        XCTAssertEqual(FremkitTXT(["a": "192.0.2.10"])?.port, 4243)
    }

    func testRefusesARecordWithoutAUsableAddress() {
        XCTAssertNil(FremkitTXT([:]))
        XCTAssertNil(FremkitTXT(["a": "studio.local"]), "a name is what could not be resolved in the first place")
        XCTAssertNil(FremkitTXT(["a": ""]))
        XCTAssertNil(FremkitTXT(["a": "192.0.2.10", "p": "0"]))
        XCTAssertNil(FremkitTXT(["a": "192.0.2.10", "p": "x"]))
    }

    func testTheAdvertisedAddressComesFirstOnceItAnswers() {
        var mac = DiscoveredMac(name: "Studio")
        XCTAssertNil(mac.service, "pending: nothing known yet")
        mac.advertised = FremkitTXT(["a": "192.0.2.10", "p": "4243"])
        XCTAssertNil(mac.service, "advertised but not checked")
        mac.resolved = MacService(name: "Studio", address: "198.51.100.7", port: 4243)
        XCTAssertEqual(mac.service?.address, "198.51.100.7")
        mac.advertisedAnswers = true
        XCTAssertEqual(mac.candidates.map(\.address), ["192.0.2.10", "198.51.100.7"])
        XCTAssertEqual(mac.service, MacService(name: "Studio", address: "192.0.2.10", port: 4243))
        mac.resolved = MacService(name: "Studio", address: "192.0.2.10", port: 4243)
        XCTAssertEqual(mac.candidates.count, 1, "the same address once")
    }

    func testConnectorCandidatesFromEveryMacOnce() {
        var a = DiscoveredMac(name: "B")
        a.advertised = FremkitTXT(["a": "192.0.2.10"])
        a.advertisedAnswers = true
        a.resolved = MacService(name: "B", address: "192.0.2.11", port: 4243)
        var b = DiscoveredMac(name: "A")
        b.resolved = MacService(name: "A", address: "192.0.2.10", port: 4243)
        let pending = DiscoveredMac(name: "C")
        XCTAssertEqual([a, b, pending].addresses, ["192.0.2.10", "192.0.2.11"])
    }
}
