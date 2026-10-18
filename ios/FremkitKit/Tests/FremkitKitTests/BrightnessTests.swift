import XCTest
@testable import FremkitKit

final class BrightnessStateTests: XCTestCase {
    func testAppliesANewSeqOnce() {
        var state = BrightnessState()
        XCTAssertTrue(state.apply(target: 40, seq: 3))
        XCTAssertFalse(state.apply(target: 40, seq: 3))
        XCTAssertFalse(state.apply(target: 80, seq: 3))
        XCTAssertEqual(state.lastApplied, 3)
    }

    func testAcceptsALowerSeqBecauseTheServerRestarted() {
        var state = BrightnessState()
        XCTAssertTrue(state.apply(target: 40, seq: 9))
        XCTAssertTrue(state.apply(target: 60, seq: 0))
        XCTAssertEqual(state.lastApplied, 0)
    }

    func testRefusesATargetThatIsNotANumber() {
        var state = BrightnessState()
        XCTAssertFalse(state.apply(target: .nan, seq: 1))
        XCTAssertNil(state.lastApplied)
    }

    func testLevelRoundsAndClamps() {
        XCTAssertEqual(BrightnessState.level(forTarget: 40), 0.4, accuracy: 1e-9)
        XCTAssertEqual(BrightnessState.level(forTarget: 140), 1)
        XCTAssertEqual(BrightnessState.level(forTarget: -5), 0)
        XCTAssertEqual(BrightnessState.level(forTarget: .infinity), 0)
    }
}

final class BrightnessSendTests: XCTestCase {
    private let reporter = BrightnessReporter(mac: sampleMac, host: "192.0.2.10")

    private func outcome(_ exchange: Exchange) async -> ReportOutcome {
        await reporter.send(brightness: 0.5, applied: nil) { _, _ in exchange }
    }

    func testMapsTheAnswer() async {
        let sent = await outcome(.response(status: 204, body: Data()))
        let unauthorized = await outcome(.response(status: 401, body: Data()))
        let noScreen = await outcome(.response(status: 409, body: Data()))
        let rejected = await outcome(.pinRejected)
        let down = await outcome(.failed)
        XCTAssertEqual(sent, .sent)
        XCTAssertEqual(unauthorized, .unauthorized)
        XCTAssertEqual(noScreen, .failed)
        XCTAssertEqual(rejected, .failed)
        XCTAssertEqual(down, .failed)
    }

    func testSendsUnderThePinOfTheMac() async {
        let seen = Seen()
        _ = await reporter.send(brightness: 0.5, applied: 2) { request, policy in
            seen.set(request, policy)
            return .response(status: 204, body: Data())
        }
        XCTAssertEqual(seen.policy?.keyHash, sampleMac.keyHash)
        XCTAssertEqual(seen.request?.httpMethod, "POST")
    }

    private final class Seen: @unchecked Sendable {
        var request: URLRequest?
        var policy: PinPolicy?
        func set(_ r: URLRequest, _ p: PinPolicy) { request = r; policy = p }
    }
}

@MainActor
final class BrightnessSyncTests: XCTestCase {
    private final class Fake: @unchecked Sendable {
        @MainActor var screen = 0.5
        let lock = NSLock()
        private var _reports: [(Double, Int?)] = []
        private var _answer: ReportOutcome = .sent
        var reports: [(Double, Int?)] { lock.withLock { _reports } }
        var answer: ReportOutcome {
            get { lock.withLock { _answer } }
            set { lock.withLock { _answer = newValue } }
        }
        func record(_ level: Double, _ applied: Int?) -> ReportOutcome {
            lock.withLock { _reports.append((level, applied)); return _answer }
        }
    }

    private func make(_ fake: Fake, unauthorized: @escaping @MainActor () -> Void = {},
                      debounce: Duration = .milliseconds(20), interval: Duration = .milliseconds(30)) -> BrightnessSync {
        BrightnessSync(read: { fake.screen }, write: { fake.screen = $0 },
                       send: { level, applied in fake.record(level, applied) },
                       unauthorized: unauthorized, debounce: debounce, interval: interval)
    }

    func testAppliesANewTargetAndReportsItWithTheSeq() async {
        let fake = Fake()
        let sync = make(fake)
        await sync.receive(target: 30, seq: 4)?.value
        XCTAssertEqual(fake.screen, 0.3, accuracy: 1e-9)
        XCTAssertEqual(fake.reports.count, 1)
        XCTAssertEqual(fake.reports[0].1, 4)
    }

    func testTheSameSeqLeavesTheScreenAloneSoControlCenterWins() async {
        let fake = Fake()
        let sync = make(fake)
        await sync.receive(target: 30, seq: 4)?.value
        fake.screen = 0.9
        XCTAssertNil(sync.receive(target: 30, seq: 4))
        XCTAssertEqual(fake.screen, 0.9)
        XCTAssertEqual(fake.reports.count, 1)
    }

    func testAppliedIsSentAgainUntilAReportLands() async {
        let fake = Fake()
        fake.answer = .failed
        let sync = make(fake)
        await sync.receive(target: 30, seq: 4)?.value
        fake.answer = .sent
        sync.levelChanged()
        try? await Task.sleep(for: .milliseconds(120))
        sync.stop()
        XCTAssertEqual(fake.reports.map { $0.1 }, [4, 4])
        // Once landed, later reports carry no `applied`.
        let task = Task { await sync.run() }
        try? await Task.sleep(for: .milliseconds(100))
        task.cancel()
        XCTAssertNil(fake.reports.last?.1)
    }

    func testLevelChangesAreDebounced() async {
        let fake = Fake()
        let sync = make(fake, debounce: .milliseconds(60))
        sync.levelChanged()
        sync.levelChanged()
        sync.levelChanged()
        try? await Task.sleep(for: .milliseconds(250))
        XCTAssertEqual(fake.reports.count, 1)
    }

    func testHeartbeatReportsUntilCancelled() async {
        let fake = Fake()
        let sync = make(fake)
        let task = Task { await sync.run() }
        try? await Task.sleep(for: .milliseconds(200))
        task.cancel()
        await task.value
        let count = fake.reports.count
        XCTAssertGreaterThanOrEqual(count, 3)
        try? await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(fake.reports.count, count)
    }

    func testA401FeedsTheUnauthorizedPath() async {
        let fake = Fake()
        fake.answer = .unauthorized
        var called = 0
        let sync = make(fake, unauthorized: { called += 1 })
        await sync.receive(target: 30, seq: 1)?.value
        XCTAssertEqual(called, 1)
    }

    func testOtherFailuresAreSilent() async {
        let fake = Fake()
        fake.answer = .failed
        var called = 0
        let sync = make(fake, unauthorized: { called += 1 })
        await sync.receive(target: 30, seq: 1)?.value
        XCTAssertEqual(called, 0)
    }
}
