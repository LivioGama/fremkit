// fremkit-nowplaying: what macOS is playing right now, and the three transport commands.
//
// Run by the dashboard server (execFile-style: absolute path, argument list, no shell) for the
// now-playing widget.
//
//   fremkit-nowplaying snapshot
//   fremkit-nowplaying command play|pause|next|previous
//
// This launcher exists only to make that one stable command line; the work happens in
// `fremkit-nowplaying.pl` and `libFremkitMediaRemote.dylib`, which sit beside it, because a
// plain binary cannot read MediaRemote on macOS 15.4 and later (see MediaRemote.swift). It
// execs `/usr/bin/perl` with fixed arguments derived from its own location, so nothing on
// `PATH` is trusted and no shell is involved.
//
// Output, `snapshot`: one JSON object on stdout
//   {"available":true,"state":"playing","title":…,"artist":…,"album":…,"app":…,
//    "artwork":…,"durationMs":…,"positionMs":…}
// A Mac with no media session answers {"available":false}, which is a fact and not an error.
// A command exits 0, or 1 with a sentence on stderr when no session took it.

import Darwin
import Foundation

let usage = "usage: fremkit-nowplaying snapshot | command play|pause|next|previous"

func fail(_ message: String, _ status: Int32) -> Never {
    FileHandle.standardError.write(Data("fremkit-nowplaying: \(message)\n".utf8))
    exit(status)
}

let here = URL(fileURLWithPath: CommandLine.arguments[0])
    .resolvingSymlinksInPath()
    .deletingLastPathComponent()
let script = here.appendingPathComponent("fremkit-nowplaying.pl").path
let library = here.appendingPathComponent("libFremkitMediaRemote.dylib").path
let perl = "/usr/bin/perl"

let arguments = Array(CommandLine.arguments.dropFirst())
let command: String
switch arguments.first {
case "snapshot" where arguments.count == 1:
    command = "snapshot"
case "command" where arguments.count == 2:
    command = arguments[1]
default:
    fail(usage, 64)
}

// A checkout built by scripts/build-helper.sh has all three in native/.build/swiftc; the app
// bundle has them in Contents/MacOS. Either way they are beside this executable.
guard FileManager.default.isReadableFile(atPath: script) else { fail("missing \(script)", 64) }
guard FileManager.default.isReadableFile(atPath: library) else { fail("missing \(library)", 64) }

var argv: [UnsafeMutablePointer<CChar>?] = [perl, script, library, command].map { strdup($0) }
argv.append(nil)
_ = argv.withUnsafeBufferPointer { buffer in
    execv(perl, buffer.baseAddress)
}
fail("cannot exec \(perl) (\(String(cString: strerror(errno))))", 64)
