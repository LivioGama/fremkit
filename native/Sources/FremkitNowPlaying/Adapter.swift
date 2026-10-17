// The entry points `adapter.pl` installs as Perl subroutines.
//
// Each takes no argument and returns an exit code, because that is the calling convention
// `DynaLoader::dl_install_xsub` gives for a C function: a Perl scalar argument would not be
// converted for us. The command is therefore part of the symbol name, not the argv.

import Foundation

@_cdecl("fremkit_adapter_snapshot")
public func fremkitAdapterSnapshot() {
    let object = nowPlayingSnapshot()
    let data = (try? JSONSerialization.data(withJSONObject: object,
                                            options: [.sortedKeys, .withoutEscapingSlashes]))
        ?? Data("{\"available\":false}".utf8)
    fputs(String(decoding: data, as: UTF8.self) + "\n", stdout)
    fflush(stdout)
}

/// Exits the interpreter rather than returning a code: a raw C function installed with
/// `dl_install_xsub` has no XS return handling, and the value it leaves in the register is read
/// as a Perl scalar (the "uninitialized value" warning). One short-lived process per command, so
/// exiting here is the honest way to report it.
private func send(_ code: UInt32, _ name: String) {
    guard nowPlayingSend(code) else {
        FileHandle.standardError.write(Data("fremkit-nowplaying: no media session to send \(name) to\n".utf8))
        exit(1)
    }
}

@_cdecl("fremkit_adapter_play")
public func fremkitAdapterPlay() { send(0, "play") }

// No TogglePlayPause (2): QuickTime Player ignores it on macOS 27, so the provider reads the
// state and asks for play or pause explicitly.
@_cdecl("fremkit_adapter_pause")
public func fremkitAdapterPause() { send(1, "pause") }

@_cdecl("fremkit_adapter_next")
public func fremkitAdapterNext() { send(4, "next") }

@_cdecl("fremkit_adapter_previous")
public func fremkitAdapterPrevious() { send(5, "previous") }
