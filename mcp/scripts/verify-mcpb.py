#!/usr/bin/env python3
"""Download the exact server.json MCPB, check its hash, and safely extract it."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import stat
import urllib.request
import zipfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--server', type=Path, default=Path('server.json'))
parser.add_argument('--output-dir', type=Path, required=True)
parser.add_argument('--bundle', type=Path, help='Use an existing local MCPB instead of downloading')
args = parser.parse_args()
server = json.loads(args.server.read_text(encoding='utf-8'))
assert server['name'] == 'io.github.SonicloudTech/mouse-mcp'
assert len(server['packages']) == 1
package = server['packages'][0]
assert package['registryType'] == 'mcpb' and package['transport']['type'] == 'stdio'
assert package['version'] == server['version']
assert package['identifier'] == (
    f"https://github.com/SonicloudTech/mouse-mcp/releases/download/v{server['version']}/"
    f"umouse-mcp-{server['version']}-win-x64.mcpb")
assert re.fullmatch('[0-9a-f]{64}', package['fileSha256'])
assert not args.output_dir.exists(), 'Extraction destination must be new'
data = args.bundle.read_bytes() if args.bundle else urllib.request.urlopen(package['identifier'], timeout=90).read()
assert hashlib.sha256(data).hexdigest() == package['fileSha256'], 'MCPB SHA-256 mismatch'
args.output_dir.mkdir(parents=True)
archive = args.output_dir / 'release.mcpb'
archive.write_bytes(data)
root = args.output_dir / 'bundle'
root.mkdir()
seen = set()
with zipfile.ZipFile(archive) as bundle:
    assert sum(item.file_size for item in bundle.infolist()) < 250 * 1024 * 1024, 'Unexpected expanded size'
    for item in bundle.infolist():
        name = item.filename
        parts = name.rstrip('/').split('/')
        assert '\\' not in name and not name.startswith('/'), 'Non-portable archive path'
        assert all(part and part not in ('.', '..') and not part.endswith((' ', '.')) for part in parts)
        assert not any(re.search(r'[<>:"|?*\x00-\x1f]', part) for part in parts)
        assert not any(re.fullmatch(r'(?i)(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?', part) for part in parts)
        assert stat.S_IFMT(item.external_attr >> 16) in (0, stat.S_IFREG, stat.S_IFDIR)
        assert not item.flag_bits & 1
        assert name.casefold() not in seen, 'Duplicate archive entry'
        seen.add(name.casefold())
        assert PurePosixPath(name).name.casefold() != 'sinicloud_asr.json', 'Credential file must not be distributed'
        target = root.joinpath(*parts)
        if item.is_dir():
            target.mkdir(parents=True, exist_ok=True)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(bundle.read(item))
manifest = json.loads((root / 'manifest.json').read_text(encoding='utf-8'))
assert manifest['version'] == server['version']
assert manifest == json.loads((args.server.parent / 'mcpb' / 'manifest.json').read_text(encoding='utf-8'))
assert (root / 'launcher.cjs').read_bytes() == (args.server.parent / 'mcpb' / 'launcher.cjs').read_bytes()
for name in ['README.md', 'LICENSE', 'THIRD_PARTY_LICENSES.txt', 'COPYING.LGPLv2.1', 'LICENSE.hidapi-bsd',
             'mcp/dist/index.js', 'lib/uMouseSdk.dll', 'lib/typer.dll',
             'node_modules/koffi/build/koffi/win32_x64/koffi.node']:
    assert (root / name).is_file(), f'Missing {name}'
assert not (root / 'install-agents.cmd').exists()
assert not (root / 'umouse-mcp.cmd').exists()
print(json.dumps({'sha256': package['fileSha256'], 'version': manifest['version'],
                  'files': len(seen), 'extracted': str(root)}, indent=2))
