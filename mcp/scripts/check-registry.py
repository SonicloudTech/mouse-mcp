#!/usr/bin/env python3
"""Check immutable Registry metadata before publishing, or require it afterwards."""
import argparse
import json
import os
from pathlib import Path
import time
import urllib.error
import urllib.parse
import urllib.request

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--require-published', action='store_true')
args = parser.parse_args()
expected = json.loads(Path('server.json').read_text(encoding='utf-8'))
endpoint = ('https://registry.modelcontextprotocol.io/v0.1/servers/'
            + urllib.parse.quote(expected['name'], safe='') + '/versions/'
            + urllib.parse.quote(expected['version'], safe=''))
response = None
for attempt in range(6 if args.require_published else 1):
    try:
        with urllib.request.urlopen(endpoint, timeout=60) as stream:
            response = json.load(stream)
        break
    except urllib.error.HTTPError as error:
        if error.code != 404:
            raise
        if args.require_published and attempt < 5:
            time.sleep(10)
if response is None:
    assert not args.require_published, 'Published Registry version not found'
    state = 'absent'
else:
    actual = response['server']
    for field in ('name', 'title', 'description', 'version', 'repository', 'websiteUrl', 'packages'):
        assert actual.get(field) == expected.get(field), f'Registry mismatch: {field}'
    official = response['_meta']['io.modelcontextprotocol.registry/official']
    assert official['status'] == 'active', 'Registry entry is not active'
    state = 'present'
if os.getenv('GITHUB_OUTPUT'):
    with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as stream:
        stream.write(f'state={state}\n')
print(json.dumps({'state': state, 'url': endpoint, 'version': expected['version']}, indent=2))
