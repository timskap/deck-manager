"""Index the connected user's captures on the Deck. Only one page travels over SSH."""
import json
import os
import re
import stat
import sys
from datetime import datetime
from pathlib import Path
from xml.etree import ElementTree as ET


IMAGES = {'.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif'}
VIDEOS = {'.mp4', '.m4v', '.webm', '.mov', '.mkv'}
DASH = 'urn:mpeg:dash:schema:mpd:2011'
ET.register_namespace('', DASH)


def capture_time(name, fallback):
    match = re.search(r'(?:^|_)(\d{8})_?(\d{6})(?:_|\.|$)', name)
    if match:
        try:
            return int(datetime.strptime(''.join(match.groups()), '%Y%m%d%H%M%S').timestamp())
        except ValueError:
            pass
    return int(fallback)


def desktop_folder(home, key, default):
    try:
        config = (home / '.config/user-dirs.dirs').read_text()
        match = re.search(r'^XDG_' + key + r'_DIR="([^"\n]+)"', config, re.M)
        if match:
            folder = Path(match[1].replace('$HOME', str(home)))
            if folder.is_absolute() and folder.resolve() not in (home.resolve(), Path('/')):
                return folder.resolve()
    except OSError:
        pass
    return home / default


def game_names(steam):
    libraries = {steam / 'steamapps'}
    try:
        config = (steam / 'steamapps/libraryfolders.vdf').read_text(errors='replace')
        libraries.update(Path(p) / 'steamapps' for p in re.findall(r'"path"\s*"(/[^"\n]+)"', config))
    except OSError:
        pass
    names = {}
    for library in libraries:
        for manifest in library.glob('appmanifest_*.acf'):
            try:
                match = re.search(r'"name"\s*"([^"\n]+)"', manifest.read_text(errors='replace'))
                if match:
                    names[manifest.stem.removeprefix('appmanifest_')] = match[1]
            except OSError:
                continue
    return names


def clip_manifest(folders):
    """Join the static Steam DASH periods so a multipart clip has one seek bar."""
    result = ET.Element(f'{{{DASH}}}MPD', type='static', minBufferTime='PT2S',
                        profiles='urn:mpeg:dash:profile:isoff-live:2011')
    parts = []
    elapsed = 0
    for folder in sorted(folders, key=lambda p: p.name.rsplit('_', 2)[-2:]):
        manifest = folder / 'session.mpd'
        if folder.is_symlink() or manifest.is_symlink() or not manifest.is_file():
            continue
        try:
            if manifest.stat().st_size > 1024 * 1024:
                continue
            root = ET.parse(manifest).getroot()
        except (OSError, ET.ParseError):
            continue
        period = root.find(f'{{{DASH}}}Period')
        duration = re.fullmatch(r'PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?', root.get('mediaPresentationDuration', ''))
        if root.get('type', 'static') != 'static' or period is None or not duration:
            continue
        try:
            hours, minutes, seconds = (float(value or 0) for value in duration.groups())
            ms = round((hours * 3600 + minutes * 60 + seconds) * 1000)
        except (ValueError, OverflowError):
            continue
        if ms <= 0:
            continue
        index = len(parts)
        out = ET.SubElement(result, f'{{{DASH}}}Period', id=str(index),
                            start=f'PT{elapsed / 1000:.3f}S', duration=f'PT{ms / 1000:.3f}S')
        ET.SubElement(out, f'{{{DASH}}}BaseURL').text = f'p{index}/'
        out.extend(period.findall(f'{{{DASH}}}AdaptationSet'))
        elapsed += ms
        parts.append(str(folder))
    if not parts:
        return None
    result.set('mediaPresentationDuration', f'PT{elapsed / 1000:.3f}S')
    return {'parts': parts, 'manifest': ET.tostring(result, encoding='unicode'), 'duration': elapsed / 1000}


def list_media(home, kind='all', offset=0, limit=36):
    entries = {}
    video_roots = {desktop_folder(home, 'VIDEOS', 'Videos').resolve()}

    def add_file(file, category, game=None, preview=None):
        try:
            info = file.lstat()
        except OSError:
            return
        if not stat.S_ISREG(info.st_mode) or not info.st_size:
            return
        entries[file] = {
            'path': str(file), 'name': file.name, 'kind': category, 'game': game,
            'time': capture_time(file.name, info.st_mtime), 'size': info.st_size,
            'thumb': str(preview) if preview and not preview.is_symlink() and preview.is_file() else None,
        }

    def scan_recordings(folder, names):
        clips = [(clip, (clip / 'video').glob('*')) for clip in (folder / 'clips').glob('clip_*')]
        clips.extend((recording, [recording]) for recording in (folder / 'video').glob('*'))
        for clip, folders in clips:
            if clip in entries or clip.is_symlink():
                continue
            data = clip_manifest(folders)
            if data:
                try:
                    modified = clip.stat().st_mtime
                except FileNotFoundError:
                    continue
                ident = clip.name.split('_')
                game = names.get(ident[1]) if len(ident) > 1 else None
                thumb = clip / 'thumbnail.jpg'
                entries[clip] = dict(data, path=str(clip), kind='video', name=clip.name, game=game,
                                     time=capture_time(clip.name, modified),
                                     thumb=str(thumb) if not thumb.is_symlink() and thumb.is_file() else None)

    steams = {p.resolve() for p in (home / '.local/share/Steam', home / '.steam/steam', home / '.steam/root',
                                    home / '.var/app/com.valvesoftware.Steam/.local/share/Steam',
                                    home / '.var/app/com.valvesoftware.Steam/data/Steam') if (p / 'userdata').is_dir()}
    names = {}
    for steam in sorted(steams):
        names.update(game_names(steam))
        for user in (steam / 'userdata').iterdir():
            if not user.name.isdecimal() or not user.is_dir():
                continue
            for shots in (user / '760/remote').glob('*/screenshots'):
                folder = shots.resolve()
                for file in folder.glob('*'):
                    if file.suffix.lower() in IMAGES:
                        add_file(file, 'image', names.get(shots.parent.name), folder / 'thumbnails' / file.name)
            recordings = user / 'gamerecordings'
            if recordings.is_dir():
                video_roots.add(recordings.resolve())

    pictures = desktop_folder(home, 'PICTURES', 'Pictures')
    sources = [(home / 'Screenshots', 'image', IMAGES), (pictures / 'Screenshots', 'image', IMAGES)]
    sources.extend((root, 'video', VIDEOS) for root in sorted(video_roots))
    for folder, category, suffixes in sources:
        for parent, dirs, files in os.walk(folder.resolve()):
            base = Path(parent)
            dirs[:] = [d for d in dirs if not d.startswith('.') and d != 'thumbnails']
            if category == 'video' and (base.name == 'gamerecordings' or 'gamerecording.pb' in files or 'clips' in dirs):
                scan_recordings(base, names)
            if category == 'video' and base.name == 'video':
                # Each native recording can have thousands of DASH fragments.
                dirs[:] = [d for d in dirs if not (base / d / 'session.mpd').is_file()]
            for name in files:
                if not name.startswith('.') and Path(name).suffix.lower() in suffixes:
                    add_file(base / name, category)

    ordered = sorted(entries.values(), key=lambda item: (item['time'], item['path']), reverse=True)
    counts = {'all': len(ordered), 'image': sum(item['kind'] == 'image' for item in ordered)}
    counts['video'] = counts['all'] - counts['image']
    selected = ordered if kind == 'all' else [item for item in ordered if item['kind'] == kind]
    return {'counts': counts, 'items': selected[offset:offset + limit]}


if __name__ == '__main__':
    try:
        request = json.load(sys.stdin)
        page = list_media(Path.home(), request['kind'], request['offset'])
        print(json.dumps({'ok': True, 'value': page}, ensure_ascii=False))
    except Exception as error:
        print(json.dumps({'ok': False, 'error': str(error)}, ensure_ascii=False))
