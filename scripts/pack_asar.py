#!/usr/bin/env python3
"""Dependency-free ASAR packer. Format and SHA256 block integrity verified on output."""
import hashlib
import json
import pathlib
import struct
import sys

BLOCK = 4 * 1024 * 1024

def build(source, destination):
    source, destination = pathlib.Path(source), pathlib.Path(destination)
    header = {"files": {}}
    content = []
    offset = 0
    for path in sorted(source.rglob('*')):
        if not path.is_file() or path.is_symlink():
            continue
        relative = path.relative_to(source)
        if relative.parts[0] not in ('electron', 'lib', 'renderer') and str(relative) != 'package.json':
            continue
        node = header
        for folder in relative.parts[:-1]:
            node = node['files'].setdefault(folder, {'files': {}})
        data = path.read_bytes()
        node['files'][relative.name] = {'size': len(data), 'offset': str(offset), 'integrity': {
            'algorithm': 'SHA256', 'hash': hashlib.sha256(data).hexdigest(), 'blockSize': BLOCK,
            'blocks': [hashlib.sha256(data[i:i+BLOCK]).hexdigest() for i in range(0, len(data), BLOCK)]}}
        content.append(data)
        offset += len(data)
    text = json.dumps(header, separators=(',', ':'), ensure_ascii=False).encode('utf8')
    payload = struct.pack('<I', len(text)) + text
    payload += bytes((-len(payload)) % 4)
    header_pickle = struct.pack('<I', len(payload)) + payload
    prefix = struct.pack('<II', 4, len(header_pickle))
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(prefix + header_pickle + b''.join(content))
    verify(destination, source)
    return hashlib.sha256(text).hexdigest()

def verify(archive, source=None):
    raw = pathlib.Path(archive).read_bytes()
    size_payload, header_size, pickle_payload, string_len = struct.unpack_from('<IIII', raw)
    assert size_payload == 4 and header_size == pickle_payload + 4
    text = raw[16:16+string_len]
    header = json.loads(text)
    base = 8 + header_size
    count = 0
    def walk(node, parent):
        nonlocal count
        for name, value in node['files'].items():
            relative = parent / name
            if 'files' in value:
                walk(value, relative)
            else:
                begin = base + int(value['offset'])
                data = raw[begin:begin+value['size']]
                assert len(data) == value['size']
                assert hashlib.sha256(data).hexdigest() == value['integrity']['hash']
                assert [hashlib.sha256(data[i:i+BLOCK]).hexdigest() for i in range(0, len(data), BLOCK)] == value['integrity']['blocks']
                if source:
                    assert data == (pathlib.Path(source) / relative).read_bytes()
                count += 1
    walk(header, pathlib.Path())
    assert count > 0
    return count

if __name__ == '__main__':
    if len(sys.argv) == 4 and sys.argv[1] == 'verify':
        print(verify(sys.argv[2], sys.argv[3]))
    elif len(sys.argv) == 3:
        print(build(sys.argv[1], sys.argv[2]))
    else:
        raise SystemExit('Usage: pack_asar.py SOURCE OUTPUT | pack_asar.py verify ARCHIVE SOURCE')
