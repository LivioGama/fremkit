#!/usr/bin/perl
#
# Runs inside /usr/bin/perl, and that is the whole point.
#
# Since macOS 15.4 the system's MediaRemote daemon refuses to answer a process that is not
# entitled: a plain tool gets "Operation not permitted", and only software signed by Apple may
# read what is playing. `/usr/bin/perl` is one of those binaries, so loading our library into it
# borrows the entitlement — the same technique as ungive/mediaremote-adapter and nowplaying-cli.
#
# Usage: perl fremkit-nowplaying.pl <libFremkitMediaRemote.dylib> snapshot|play|pause|next|previous
# Prints one JSON object for `snapshot`; exits 0/1 for the commands.

use strict;
use warnings;
use DynaLoader;

my ($lib, $command) = @ARGV;
if (!$lib || !$command) {
    print STDERR "usage: fremkit-nowplaying.pl <library> snapshot|play|pause|next|previous\n";
    exit 64;
}

my %entry = (
    snapshot  => 'fremkit_adapter_snapshot',
    play     => 'fremkit_adapter_play',
    pause    => 'fremkit_adapter_pause',
    next      => 'fremkit_adapter_next',
    previous  => 'fremkit_adapter_previous',
);
my $symbol = $entry{$command};
if (!$symbol) {
    print STDERR "fremkit-nowplaying: no command named $command\n";
    exit 64;
}

my $handle = DynaLoader::dl_load_file($lib, 0)
    or die "fremkit-nowplaying: cannot load $lib: " . DynaLoader::dl_error() . "\n";
my $address = DynaLoader::dl_find_symbol($handle, $symbol)
    or die "fremkit-nowplaying: $lib has no $symbol\n";
my $call = DynaLoader::dl_install_xsub("main::$symbol", $address);
&$call();
exit 0;
