// The MediaRemote calls, shared by the perl-loaded library the adapter uses.
//
// Since macOS 15.4 and still in 27, `mediaremoted` answers a plain binary with
// `kMRMediaRemoteFrameworkErrorDomain Code=3 "Operation not permitted"` unless the calling
// process is entitled — a tool signed by Apple. A `perl` script that loads this file as a
// library inherits `/usr/bin/perl`'s entitlement, which is the documented workaround
// (ungive/mediaremote-adapter, nowplaying-cli). So this file must not be a program: it only
// exposes the calls, and `Adapter.swift` wraps them for the script.
//
// MediaRemote's command enum: Play 0, Pause 1, TogglePlayPause 2, Stop 3, NextTrack 4,
// PreviousTrack 5. The numbers for the two track buttons are not in the order they appear.

import AppKit
import Darwin
import Dispatch
import Foundation

let mediaRemoteFramework = "/System/Library/PrivateFrameworks/MediaRemote.framework/MediaRemote"

enum MediaRemote {
    typealias InfoHandler = @convention(block) (CFDictionary?) -> Void
    typealias GetInfo = @convention(c) (AnyObject?, InfoHandler) -> Void
    typealias PIDHandler = @convention(block) (Int32) -> Void
    typealias GetPID = @convention(c) (AnyObject?, PIDHandler) -> Void
    typealias PlayingHandler = @convention(block) (Bool) -> Void
    typealias GetPlaying = @convention(c) (AnyObject?, PlayingHandler) -> Void
    typealias SendCommand = @convention(c) (UInt32, UnsafeMutableRawPointer?) -> Bool

    static let handle: UnsafeMutableRawPointer? = dlopen(mediaRemoteFramework, RTLD_NOW)

    static func load<T>(_ name: String, as type: T.Type) -> T? {
        guard let handle, let found = dlsym(handle, name) else { return nil }
        return unsafeBitCast(found, to: T.self)
    }

    static var getInfo: GetInfo? { load("MRMediaRemoteGetNowPlayingInfo", as: GetInfo.self) }
    static var getPID: GetPID? { load("MRMediaRemoteGetNowPlayingApplicationPID", as: GetPID.self) }
    static var getPlaying: GetPlaying? { load("MRMediaRemoteGetNowPlayingApplicationIsPlaying", as: GetPlaying.self) }
    static var sendCommand: SendCommand? { load("MRMediaRemoteSendCommand", as: SendCommand.self) }
}

/// What a block MediaRemote answered. A class rather than captured locals because the compiler
/// treats the block as non-escaping at the call site, and MediaRemote keeps it for later.
final class Answer<T> {
    var value: T?
    var answered = false
}

/// Drains the main queue until `done` or the deadline: every MediaRemote read answers through a
/// block scheduled on it, and an interpreter has no app run loop to do that for us.
func pump(until done: () -> Bool, seconds: TimeInterval) {
    let deadline = Date().addingTimeInterval(seconds)
    while !done() && Date() < deadline {
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.02))
    }
}

func stringField(_ info: [String: Any], _ key: String) -> String? {
    let value = (info[key] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
    return value?.isEmpty == false ? value : nil
}

/**
 The cover, as a data URL the widget can put in an <img>.

 MediaRemote hands over the player's raw artwork bytes (`…ArtworkData`), not a URL, and they can
 be a megabyte. A 96 px JPEG is a few kilobytes: small enough to travel with the snapshot every
 second over the local socket, and sharp enough for a 64 px tile. The comment on `nowPlayingSnapshot`
 used to say "no artwork bytes" — this is the one deliberate exception.
 */
func artworkDataURL(_ value: Any?) -> String? {
    let data: Data?
    if let value = value as? Data {
        data = value
    } else if let value = value as? NSData {
        data = value as Data
    } else {
        data = nil
    }
    // The player decides what bytes these are; a giant image would be decoded every poll.
    guard let data, !data.isEmpty, data.count <= 8 * 1024 * 1024, let image = NSImage(data: data) else { return nil }
    let side = 96
    guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: side, pixelsHigh: side,
                                     bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                                     isPlanar: false, colorSpaceName: .deviceRGB,
                                     bytesPerRow: 0, bitsPerPixel: 0),
          let context = NSGraphicsContext(bitmapImageRep: rep) else { return nil }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    // Aspect fill, centred: album art is square, a video frame is not, and neither may stretch.
    let canvas = CGFloat(side)
    let scale = max(canvas / image.size.width, canvas / image.size.height)
    let drawn = NSSize(width: image.size.width * scale, height: image.size.height * scale)
    image.draw(in: NSRect(x: (canvas - drawn.width) / 2, y: (canvas - drawn.height) / 2,
                          width: drawn.width, height: drawn.height))
    NSGraphicsContext.restoreGraphicsState()
    guard let jpeg = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.7]) else { return nil }
    return "data:image/jpeg;base64," + jpeg.base64EncodedString()
}

func milliseconds(_ value: Any?) -> Int? {
    guard let number = value as? NSNumber else { return nil }
    let seconds = number.doubleValue
    guard seconds.isFinite, seconds >= 0 else { return nil }
    return Int((seconds * 1000).rounded())
}

/// The app that owns the session: a PID when there is one, 0 when nothing is playing.
func nowPlayingApplicationPID() -> pid_t? {
    guard let getPID = MediaRemote.getPID else { return nil }
    let answer = Answer<pid_t>()
    let handler: @convention(block) (Int32) -> Void = { value in
        answer.value = value
        answer.answered = true
    }
    getPID(DispatchQueue.main, handler)
    pump(until: { answer.answered }, seconds: 0.4)
    guard let pid = answer.value, pid > 0 else { return nil }
    return pid
}

func applicationName(_ pid: pid_t) -> String? {
    NSRunningApplication(processIdentifier: pid)?.localizedName
}

/// Shown and driven by the widget, and nothing else: no paths, no bundle ids, no artwork bytes.
func nowPlayingSnapshot() -> [String: Any] {
    guard let getInfo = MediaRemote.getInfo else { return ["available": false, "error": "mediaremote"] }
    let answer = Answer<[String: Any]>()
    let handler: @convention(block) (CFDictionary?) -> Void = { dictionary in
        answer.value = dictionary as? [String: Any] ?? [:]
        answer.answered = true
    }
    getInfo(DispatchQueue.main, handler)
    pump(until: { answer.answered }, seconds: 1.0)
    guard let info = answer.value else { return ["available": false] }

    let title = stringField(info, "kMRMediaRemoteNowPlayingInfoTitle")
    let artist = stringField(info, "kMRMediaRemoteNowPlayingInfoArtist")
    let album = stringField(info, "kMRMediaRemoteNowPlayingInfoAlbum")
    let artwork = artworkDataURL(info["kMRMediaRemoteNowPlayingInfoArtworkData"])
    // The rate says playing, but a paused app keeps the last rate it had on some players;
    // `MRMediaRemoteGetNowPlayingApplicationIsPlaying` is the question the Menu Bar asks.
    var state: String?
    if let getPlaying = MediaRemote.getPlaying {
        let playing = Answer<Bool>()
        let playingHandler: @convention(block) (Bool) -> Void = { value in
            playing.value = value
            playing.answered = true
        }
        getPlaying(DispatchQueue.main, playingHandler)
        pump(until: { playing.answered }, seconds: 0.4)
        if let isPlaying = playing.value { state = isPlaying ? "playing" : "paused" }
    }
    if state == nil, let rate = (info["kMRMediaRemoteNowPlayingInfoPlaybackRate"] as? NSNumber)?.doubleValue, rate.isFinite {
        state = rate > 0 ? "playing" : "paused"
    }

    // A video with no title still has a session, and its controls must obey it: the PID is the
    // evidence that something is playing, not the presence of text.
    let pid = nowPlayingApplicationPID()
    var out: [String: Any] = ["available": title != nil || artist != nil || album != nil || pid != nil]
    if let state { out["state"] = state }
    if let title { out["title"] = title }
    if let artist { out["artist"] = artist }
    if let album { out["album"] = album }
    if let artwork { out["artwork"] = artwork }
    if let duration = milliseconds(info["kMRMediaRemoteNowPlayingInfoDuration"]) { out["durationMs"] = duration }
    if let position = milliseconds(info["kMRMediaRemoteNowPlayingInfoElapsedTime"]) { out["positionMs"] = position }
    if let pid, let app = applicationName(pid) { out["app"] = app }
    return out
}

func nowPlayingSend(_ code: UInt32) -> Bool {
    guard let send = MediaRemote.sendCommand else { return false }
    let sent = send(code, nil)
    // The command goes over XPC to `mediaremoted`; exiting the interpreter immediately can pull
    // the connection out from under it before the daemon has read the message.
    pump(until: { false }, seconds: 0.4)
    return sent
}
