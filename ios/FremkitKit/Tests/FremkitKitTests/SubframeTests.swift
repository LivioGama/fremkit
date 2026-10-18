import FremkitKit
import XCTest

final class SubframeTests: XCTestCase {
    private func allowed(_ string: String, host: String = "studio.local", port: Int = 4243) -> Bool {
        Dashboard.allowsSubframe(URL(string: string), host: host, port: port)
    }

    func testAllowsTheMacsWidgets() {
        XCTAssertTrue(allowed("https://studio.local:4243/widgets/clock/index.html"))
        XCTAssertTrue(allowed("https://STUDIO.local:4243/widgets/clock/index.html?x=1#y"))
        XCTAssertTrue(allowed("https://studio.local.:4243/widgets/clock/"))
        XCTAssertTrue(allowed("https://192.0.2.10:4243/widgets/clock/index.html", host: "192.0.2.10"))
        XCTAssertTrue(allowed("https://[fe80::1%25en0]:4243/widgets/clock/index.html", host: "fe80::1%en0"))
        XCTAssertTrue(allowed("https://example.local/widgets/clock/index.html", host: "example.local", port: 443))
    }

    func testRefusesAnythingElse() {
        for url in [
            "https://evil.example:4243/widgets/clock/index.html",
            "https://studio.local:4242/widgets/clock/index.html",
            "https://studio.local/widgets/clock/index.html",
            "http://studio.local:4243/widgets/clock/index.html",
            "https://studio.local:4243/",
            "https://studio.local:4243/index.html",
            "https://studio.local:4243/api/config",
            "https://studio.local:4243/widgetsx/clock/index.html",
            "https://studio.local:4243/widgets",
            "https://studio.local:4243/widgets/%2e%2e/admin.html",
            "https://studio.local:4243/widgets/clock/%2E%2E/%2E%2E/api/config",
            "https://studio.local:4243/widgets/clock%5c..%5cadmin.html",
            "https://user:pw@studio.local:4243/widgets/clock/index.html",
            "about:blank",
            "about:srcdoc",
            "data:text/html,hi",
            "javascript:alert(1)",
            "blob:https://studio.local:4243/1234",
        ] {
            XCTAssertFalse(allowed(url), url)
        }
        XCTAssertFalse(Dashboard.allowsSubframe(nil, host: "studio.local", port: 4243))
    }
}
