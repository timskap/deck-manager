"""Small SSH-side helper. Invoked from stdin; never installed as a daemon."""
import json
import os
import pathlib
import shutil
import socket
import stat
import sys
import tempfile
import time
import urllib.request
import zipfile


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix='.deck-manager-')
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def read_json(path, default=None):
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return default


def css_call(method, args):
    allowed = {'get_themes', 'get_backend_version', 'set_theme_state', 'reset', 'fetch_theme_path'}
    if method not in allowed:
        raise ValueError('Unsupported CSS Loader method')
    request = urllib.request.Request('http://127.0.0.1:35821/req',
        data=json.dumps({'method': method, 'args': args}).encode(),
        headers={'Content-Type': 'application/json'})
    # Ignore HTTP proxy environment settings: this API is always on the Deck.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(request, timeout=20) as response:
        result = json.load(response)
    if not result.get('success'):
        raise RuntimeError(str(result.get('res', 'CSS Loader error')))
    value = result.get('res')
    if isinstance(value, dict) and value.get('success') is False:
        raise RuntimeError(value.get('message', 'CSS Loader error'))
    return value


def install_theme(archive, themes):
    """Validate everything before extracting; refuse to replace installed themes."""
    archive = pathlib.Path(archive)
    themes = pathlib.Path(themes)
    with zipfile.ZipFile(archive) as source:
        entries = source.infolist()
        if len(entries) > 10000 or sum(x.file_size for x in entries) > 512 * 1024 * 1024:
            raise ValueError('ZIP exceeds 10,000 files or 512 MB unpacked')
        seen = set()
        for entry in entries:
            path = pathlib.PurePosixPath(entry.filename)
            if path.is_absolute() or '..' in path.parts or '\\' in entry.filename or '\0' in entry.filename:
                raise ValueError('Unsafe path in ZIP')
            mode = entry.external_attr >> 16
            if stat.S_ISLNK(mode) or (stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR)):
                raise ValueError('Links and special files are not allowed in ZIP')
            if str(path) in seen:
                raise ValueError('Duplicate path in ZIP')
            seen.add(str(path))
        manifests = [x for x in entries if pathlib.PurePosixPath(x.filename).name == 'theme.json' and not x.filename.startswith('__MACOSX/')]
        if len(manifests) != 1:
            raise ValueError('ZIP must contain exactly one theme.json')
        manifest = manifests[0]
        if manifest.file_size > 1024 * 1024:
            raise ValueError('theme.json is too large')
        metadata = json.loads(source.read(manifest))
        if not isinstance(metadata.get('name'), str) or not metadata['name'].strip():
            raise ValueError('theme.json has no name')
        prefix = pathlib.PurePosixPath(manifest.filename).parent
        folder = prefix.name if str(prefix) != '.' else archive.stem
        if not folder or folder in ('.', '..') or '/' in folder or '\\' in folder:
            raise ValueError('Invalid theme folder')
        themes.mkdir(parents=True, exist_ok=True)
        destination = themes / folder
        if destination.exists() or destination.is_symlink():
            raise ValueError('Theme folder already exists. Existing theme was not changed.')
        with tempfile.TemporaryDirectory(prefix='.deck-manager-', dir=themes) as temporary:
            stage = pathlib.Path(temporary) / folder
            stage.mkdir()
            for entry in entries:
                path = pathlib.PurePosixPath(entry.filename)
                if not path.is_relative_to(prefix) or entry.filename.startswith('__MACOSX/'):
                    continue
                relative = path.relative_to(prefix)
                if str(relative) == '.':
                    continue
                target = stage / str(relative)
                if entry.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with source.open(entry) as incoming, target.open('xb') as output:
                        shutil.copyfileobj(incoming, output)
            stage.rename(destination)
    return {'name': metadata['name'], 'path': str(destination)}


def handle(data):
    home = pathlib.Path(sys.argv[1]) if len(sys.argv) == 2 and os.geteuid() == 0 else pathlib.Path.home()
    brew = home / 'homebrew'
    action = data['action']
    if action == 'status':
        plugins = []
        for manifest in (brew / 'plugins').glob('*/plugin.json'):
            try:
                meta = read_json(manifest, {})
                plugins.append({'name': meta.get('name', manifest.parent.name), 'folder': manifest.parent.name})
            except (ValueError, OSError):
                continue
        battery = None
        for path in pathlib.Path('/sys/class/power_supply').glob('*'):
            try:
                if (path / 'type').read_text().strip() == 'Battery':
                    battery = {'percent': int((path / 'capacity').read_text()), 'status': (path / 'status').read_text().strip()}
                    break
            except (ValueError, OSError):
                continue
        usage = shutil.disk_usage(home)
        os_release = pathlib.Path('/etc/os-release')
        return {'hostname': socket.gethostname(), 'home': str(home), 'os': os_release.read_text() if os_release.exists() else '',
                'plugins': plugins, 'battery': battery, 'disk': {'total': usage.total, 'free': usage.free},
                'pspInstalled': (brew / 'plugins/psp-xmb/plugin.json').exists()}
    if action == 'psp-get' or action == 'psp-set':
        path = brew / 'settings/psp-xmb/settings.json'
        defaults = {'enabled': False, 'palette': 'classic', 'language': 'en', 'sounds': True, 'motion': True, 'installedOnly': True, 'gameBackground': True, 'groupByFolders': True}
        value = read_json(path, defaults)
        if not isinstance(value, dict):
            raise ValueError('PSP XMB settings are damaged')
        value = {**defaults, **value}
        if action == 'psp-set':
            if not (brew / 'plugins/psp-xmb/plugin.json').exists():
                raise ValueError('PSP XMB is not installed')
            changes = data['settings']
            for key, item in changes.items():
                if key in ('enabled', 'sounds', 'motion', 'installedOnly', 'gameBackground', 'groupByFolders') and type(item) is bool:
                    value[key] = item
                elif key == 'palette' and item in ('classic', 'midnight', 'violet', 'silver', 'graphite', 'red', 'orange', 'gold', 'green', 'mint', 'pink', 'pearl'):
                    value[key] = item
                elif key == 'language' and item in ('en', 'ru'):
                    value[key] = item
                else:
                    raise ValueError('Invalid PSP setting: ' + key)
            if path.exists():
                shutil.copy2(path, path.with_name('settings.before-manager.json'))
            atomic_json(path, value)
        return value
    if action == 'css':
        return css_call(data['method'], data.get('args', {}))
    if action == 'css-prepare':
        plugin = brew / 'plugins/SDH-CssLoader'
        if not (plugin / 'css_server.py').is_file():
            raise ValueError('Install CSS Loader from the Decky store first')
        # Official CSS Loader config flag, read by store_or_file_config("server").
        themes = brew / 'themes'
        themes.mkdir(exist_ok=True)
        (themes / 'SERVER').touch(exist_ok=True)
        return {'restartRequired': True}
    if action == 'theme-install':
        themes = css_call('fetch_theme_path', {})
        result = install_theme(data['path'], themes)
        try:
            css_call('reset', {})
        except Exception as error:
            result['warning'] = 'Theme installed; reload CSS Loader: ' + str(error)
        return result
    if action == 'psp-stage':
        if not (brew / 'plugins').is_dir():
            raise ValueError('Install Decky Loader first')
        cache = home / '.cache'
        cache.mkdir(exist_ok=True)
        return tempfile.mkdtemp(prefix='deck-manager-psp-', dir=cache)
    if action == 'psp-install':
        stage = pathlib.Path(data['stage']).resolve()
        if stage.parent != (home / '.cache').resolve() or not stage.name.startswith('deck-manager-psp-'):
            raise ValueError('Invalid staging folder')
        if read_json(stage / 'plugin.json', {}).get('name') != 'PSP XMB' or not (stage / 'dist/index.js').is_file():
            raise ValueError('Invalid PSP XMB package')
        destination = brew / 'plugins/psp-xmb'
        backup = None
        if destination.exists():
            backups = brew / 'psp-xmb-backups'
            backups.mkdir(exist_ok=True)
            backup = backups / ('psp-xmb-' + str(time.time_ns()))
            destination.rename(backup)
        try:
            stage.rename(destination)
        except Exception:
            if backup:
                backup.rename(destination)
            raise
        return {'path': str(destination), 'backup': str(backup) if backup else None}
    raise ValueError('Unknown action')


if __name__ == '__main__':
    try:
        print(json.dumps({'ok': True, 'value': handle(json.load(sys.stdin))}, ensure_ascii=False))
    except Exception as error:
        print(json.dumps({'ok': False, 'error': str(error)}, ensure_ascii=False))
