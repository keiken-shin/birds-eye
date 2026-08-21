# SHA-256 hashing helper for SSH-sourced indexes. Reads NUL-terminated request
# records from stdin, writes NUL-terminated response records to stdout:
#   request:  key TAB size TAB spec TAB path NUL   (spec: "full" or off:len,...)
#   response: key TAB hex64 NUL   |   key TAB ERR TAB message NUL
# size is authoritative (it comes from the index); this never stats a file.
# The stream is consumed incrementally - hundreds of thousands of records must
# never be buffered. ASCII only: this file travels base64'd on a command line.

import hashlib
import os
import sys

READ_BLOCK = 1 << 20
FLUSH_EVERY = 64


def full_digest(path):
    digest = hashlib.sha256()
    handle = open(path, 'rb')
    try:
        while True:
            block = handle.read(READ_BLOCK)
            if not block:
                break
            digest.update(block)
    finally:
        handle.close()
    return digest.hexdigest()


def chunk_digest(path, size, spec):
    # Framing mirrors the local hasher: size_le64, then per chunk
    # offset_le64, actual_read_len_le64, bytes.
    digest = hashlib.sha256()
    digest.update(size.to_bytes(8, 'little'))
    handle = open(path, 'rb')
    try:
        for part in spec.split(','):
            bits = part.split(':')
            if len(bits) != 2:
                continue
            offset = int(bits[0])
            length = int(bits[1])
            if length <= 0 or offset >= size:
                continue
            wanted = length
            if size - offset < wanted:
                wanted = size - offset
            handle.seek(offset)
            data = handle.read(wanted)
            digest.update(offset.to_bytes(8, 'little'))
            digest.update(len(data).to_bytes(8, 'little'))
            digest.update(data)
    finally:
        handle.close()
    return digest.hexdigest()


def handle_record(record, out):
    parts = record.split(b'\t', 3)
    if len(parts) != 4:
        return False
    key = parts[0]
    try:
        size = int(parts[1])
        spec = parts[2].decode('ascii')
        path = os.fsdecode(parts[3])
        if spec == 'full':
            hexed = full_digest(path)
        else:
            hexed = chunk_digest(path, size, spec)
        out.write(key + b'\t' + hexed.encode('ascii') + b'\0')
    except Exception as error:
        # A per-file failure is reported, never fatal: the stream carries on.
        message = str(error) or error.__class__.__name__
        for bad in ('\r', '\n', '\t', '\0'):
            message = message.replace(bad, ' ')
        out.write(key + b'\tERR\t' + message.encode('utf-8', 'replace') + b'\0')
    return True


def main():
    source = sys.stdin.buffer
    out = sys.stdout.buffer
    pending = b''
    done = 0
    while True:
        block = source.read1(READ_BLOCK)
        if not block:
            break
        pending += block
        while True:
            cut = pending.find(b'\0')
            if cut < 0:
                break
            record = pending[:cut]
            pending = pending[cut + 1:]
            if record and handle_record(record, out):
                done += 1
                if done % FLUSH_EVERY == 0:
                    out.flush()
    out.flush()


main()
