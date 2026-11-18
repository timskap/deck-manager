#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
deck_ip="${1:-}"
host_key_alias="${2:-$deck_ip}"
if [[ ! "$deck_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ || ! "$host_key_alias" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ ]]; then
  echo 'Usage: bash scripts/pair-deck.sh DECK_IP [KNOWN_HOST_ALIAS]' >&2; exit 2
fi
test -f "$root/.cache/pairing-private/known_hosts"
test -f "$root/.cache/pairing-private/deck_key.pub"
echo 'Enter the deck account password at the SSH prompt. It is not saved.'
python3 - "$root/.cache/pairing-private/deck_key.pub" <<'PY' | ssh \
  -o ConnectTimeout=6 \
  -o StrictHostKeyChecking=yes \
  -o "HostKeyAlias=$host_key_alias" \
  -o UserKnownHostsFile="$root/.cache/pairing-private/known_hosts" \
  -o PubkeyAuthentication=no \
  -o PreferredAuthentications=keyboard-interactive,password \
  "deck@$deck_ip" python3 -
import pathlib, sys
public_key = pathlib.Path(sys.argv[1]).read_text().strip()
script = '''
import os, pathlib, tempfile
public_key = PUBLIC_KEY
source = os.environ['SSH_CONNECTION'].split()[0]
directory = pathlib.Path.home() / '.ssh'
directory.mkdir(mode=0o700, exist_ok=True)
path = directory / 'authorized_keys'
old = path.read_text() if path.exists() else ''
key_data = public_key.split()[1]
lines = [line for line in old.splitlines() if key_data not in line.split()]
lines.append(f'from="{source}",no-agent-forwarding,no-X11-forwarding {public_key}')
fd, temporary = tempfile.mkstemp(dir=directory, prefix='.psp-key-')
with os.fdopen(fd, 'w') as output:
    output.write('\\n'.join(lines) + '\\n')
os.chmod(temporary, 0o600)
os.replace(temporary, path)
print(f'SSH key updated for this Mac ({source}). Password was not saved.')
'''
print(script.replace('PUBLIC_KEY', repr(public_key)))
PY
echo 'Pairing complete. Open Deck Manager and select the project key to connect.'
