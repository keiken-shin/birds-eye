# SHA-256 hashing helper for SSH-sourced indexes - the fallback for hosts
# without python3. Same wire protocol and same digest framing as the Python
# helper, so the two are byte-identical by construction:
#   request:  key TAB size TAB spec TAB path NUL   (spec: "full" or off:len,...)
#   response: key TAB hex64 NUL   |   key TAB ERR TAB message NUL
# The stream is read one NUL-terminated record at a time, never slurped.
# ASCII only: this file travels base64'd on a command line.

use strict;
use warnings;
use Digest::SHA;
use IO::Handle;

my $READ_BLOCK = 1048576;
my $FLUSH_EVERY = 64;

# Fill up to $wanted bytes; a short sysread is resumed so the digest frames the
# same byte count the Python helper would.
sub read_exact {
    my ($fh, $wanted) = @_;
    my $data = '';
    while (length($data) < $wanted) {
        my $piece = '';
        my $got = sysread($fh, $piece, $wanted - length($data));
        die "read failed: $!\n" unless defined $got;
        last if $got == 0;
        $data .= $piece;
    }
    return $data;
}

sub full_digest {
    my ($path) = @_;
    my $sha = Digest::SHA->new(256);
    open(my $fh, '<', $path) or die "$!\n";
    binmode($fh);
    while (1) {
        my $block = '';
        my $got = sysread($fh, $block, $READ_BLOCK);
        unless (defined $got) {
            close($fh);
            die "read failed: $!\n";
        }
        last if $got == 0;
        $sha->add($block);
    }
    close($fh);
    return $sha->hexdigest;
}

sub chunk_digest {
    my ($path, $size, $spec) = @_;
    my $sha = Digest::SHA->new(256);
    $sha->add(pack('Q<', $size));
    open(my $fh, '<', $path) or die "$!\n";
    binmode($fh);
    for my $part (split(/,/, $spec)) {
        my ($offset, $length) = split(/:/, $part, 2);
        next unless defined $offset && defined $length;
        $offset += 0;
        $length += 0;
        next if $length <= 0 || $offset >= $size;
        my $wanted = $length;
        $wanted = $size - $offset if ($size - $offset) < $wanted;
        unless (defined sysseek($fh, $offset, 0)) {
            close($fh);
            die "seek failed: $!\n";
        }
        my $data = eval { read_exact($fh, $wanted) };
        if (!defined $data) {
            my $err = $@;
            close($fh);
            die $err;
        }
        $sha->add(pack('Q<', $offset));
        $sha->add(pack('Q<', length($data)));
        $sha->add($data);
    }
    close($fh);
    return $sha->hexdigest;
}

binmode(STDIN);
binmode(STDOUT);
local $/ = "\0";
my $done = 0;

while (defined(my $record = <STDIN>)) {
    chomp($record);
    next if $record eq '';
    my ($key, $size, $spec, $path) = split(/\t/, $record, 4);
    next unless defined $path;
    my $hex = eval {
        $spec eq 'full' ? full_digest($path) : chunk_digest($path, $size + 0, $spec);
    };
    if (defined $hex) {
        print STDOUT $key . "\t" . $hex . "\0";
    } else {
        # A per-file failure is reported, never fatal: the stream carries on.
        my $message = $@;
        $message = 'hashing failed' unless defined $message && $message ne '';
        $message =~ s/[\r\n\t\0]+/ /g;
        $message =~ s/\s+$//;
        print STDOUT $key . "\tERR\t" . $message . "\0";
    }
    $done++;
    STDOUT->flush() if $done % $FLUSH_EVERY == 0;
}

STDOUT->flush();
