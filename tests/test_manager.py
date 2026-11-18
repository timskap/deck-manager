import importlib.util
import json
import os
import pathlib
import stat
import tempfile
import unittest
import zipfile
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('remote', pathlib.Path(__file__).parents[1] / 'manager/remote.py')
remote = importlib.util.module_from_spec(spec)
spec.loader.exec_module(remote)
media_spec = importlib.util.spec_from_file_location('media', pathlib.Path(__file__).parents[1] / 'manager/media.py')
media = importlib.util.module_from_spec(media_spec)
media_spec.loader.exec_module(media)


class ManagerTest(unittest.TestCase):
    def test_media_filters_pages_and_deduplicates_steam_aliases_and_thumbnails(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = pathlib.Path(temporary)
            steam = home / '.local/share/Steam'
            shots = steam / 'userdata/9/760/remote/42/screenshots'
            thumbs = shots / 'thumbnails'
            thumbs.mkdir(parents=True)
            shot = shots / '20260203123045_1.jpg'
            shot.write_bytes(b'original')
            (thumbs / shot.name).write_bytes(b'thumb')
            (shots / 'link.png').symlink_to(shot)
            (home / '.steam').mkdir()
            (home / '.steam/steam').symlink_to(steam)
            (steam / 'steamapps').mkdir()
            (steam / 'steamapps/appmanifest_42.acf').write_text('"name" "Тестовая игра"')
            (home / '.config').mkdir()
            (home / '.config/user-dirs.dirs').write_text('XDG_VIDEOS_DIR="$HOME/Видео"')
            videos = home / 'Видео'
            videos.mkdir()
            movie = videos / 'клип #1.MP4'
            movie.write_bytes(b'video')
            os.utime(movie, (100, 100))
            (videos / 'chunk-stream0-00001.m4s').write_bytes(b'fragment')
            page = media.list_media(home, limit=1)
            self.assertEqual(page['counts'], {'all': 2, 'video': 1, 'image': 1})
            self.assertEqual(page['items'][0]['game'], 'Тестовая игра')
            self.assertEqual(pathlib.Path(page['items'][0]['thumb']).read_bytes(), b'thumb')
            self.assertEqual(media.list_media(home, offset=1)['items'], media.list_media(home, 'video')['items'])
            self.assertEqual(media.list_media(home, 'image', offset=1)['items'], [])

    def test_steam_clip_has_one_seekable_timeline_and_separate_segment_directories(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = pathlib.Path(temporary)
            clips = home / '.local/share/Steam/userdata/1/gamerecordings/clips'
            clip = clips / 'clip_42_20260101_120000'
            for n, seconds in [(2, '4.50'), (1, '13.25')]:
                folder = clip / 'video' / f'fg_42_20260101_12000{n}'
                folder.mkdir(parents=True)
                (folder / 'session.mpd').write_text(
                    f'<MPD xmlns="{media.DASH}" type="static" mediaPresentationDuration="PT{seconds}S">'
                    '<Period><AdaptationSet><Representation id="0"/></AdaptationSet></Period></MPD>')
            (clip / 'thumbnail.jpg').write_bytes(b'thumb')
            # Steam can also sync metadata for a clip with no local footage.
            (clips / 'clip_42_empty').mkdir()
            (clips / 'clip_42_empty/clip.pb').write_bytes(b'metadata')
            page = media.list_media(home)
            self.assertEqual(page['counts'], {'all': 1, 'video': 1, 'image': 0})
            item = page['items'][0]
            self.assertEqual(item['duration'], 17.75)
            self.assertTrue(item['parts'][0].endswith('120001'))
            mpd = media.ET.fromstring(item['manifest'])
            self.assertEqual(mpd.get('mediaPresentationDuration'), 'PT17.750S')
            periods = mpd.findall('{*}Period')
            self.assertEqual(periods[1].get('start'), 'PT13.250S')
            self.assertEqual([p.findtext('{*}BaseURL') for p in periods], ['p0/', 'p1/'])

    def test_install_zip_and_preserve_existing_theme(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            archive = root / 'test.zip'
            with zipfile.ZipFile(archive, 'w') as output:
                output.writestr('sample/theme.json', json.dumps({'name': 'Sample'}))
                output.writestr('sample/css/main.css', 'body { color: red; }')
            result = remote.install_theme(archive, root / 'themes')
            self.assertEqual(result['name'], 'Sample')
            self.assertEqual((root / 'themes/sample/css/main.css').read_text(), 'body { color: red; }')
            with self.assertRaisesRegex(ValueError, 'already exists'):
                remote.install_theme(archive, root / 'themes')

    def test_zip_traversal_and_symlinks_rejected_before_any_extraction(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            for name in ['../escape', '/absolute', 'folder/../../escape', 'folder\\escape']:
                with self.subTest(name=name):
                    with zipfile.ZipFile(root / 'bad.zip', 'w') as output:
                        output.writestr('theme.json', '{"name":"test"}')
                        output.writestr(name, 'bad')
                    with self.assertRaises(ValueError):
                        remote.install_theme(root / 'bad.zip', root / 'themes')
                    self.assertFalse((root / 'themes').exists())
            with zipfile.ZipFile(root / 'link.zip', 'w') as output:
                output.writestr('theme.json', '{"name":"test"}')
                link = zipfile.ZipInfo('link')
                link.external_attr = (stat.S_IFLNK | 0o777) << 16
                output.writestr(link, '/etc/passwd')
            with self.assertRaisesRegex(ValueError, 'Links'):
                remote.install_theme(root / 'link.zip', root / 'themes')

    def test_psp_update_preserves_other_settings_and_creates_backup(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(pathlib.Path, 'home', return_value=pathlib.Path(temporary)):
            home = pathlib.Path(temporary)
            manifest = home / 'homebrew/plugins/psp-xmb/plugin.json'
            manifest.parent.mkdir(parents=True)
            manifest.write_text('{"name":"PSP XMB"}')
            path = home / 'homebrew/settings/psp-xmb/settings.json'
            remote.atomic_json(path, {'enabled': False, 'palette': 'classic', 'language': 'ru'})
            value = remote.handle({'action': 'psp-set', 'settings': {'palette': 'pearl'}})
            self.assertEqual(value['language'], 'ru')
            self.assertFalse(value['enabled'])
            self.assertEqual(json.loads(path.read_text())['palette'], 'pearl')
            self.assertEqual(json.loads(path.with_name('settings.before-manager.json').read_text())['palette'], 'classic')
            with self.assertRaises(ValueError):
                remote.handle({'action': 'psp-set', 'settings': {'enabled': 'false'}})
            self.assertEqual(list(path.parent.glob('.deck-manager-*')), [])

    def test_psp_install_keeps_previous_plugin_and_rejects_unrelated_stage(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(pathlib.Path, 'home', return_value=pathlib.Path(temporary)):
            home = pathlib.Path(temporary)
            old = home / 'homebrew/plugins/psp-xmb'
            old.mkdir(parents=True)
            (old / 'original.txt').write_text('keep me')
            stage = pathlib.Path(remote.handle({'action': 'psp-stage'}))
            (stage / 'dist').mkdir()
            (stage / 'plugin.json').write_text('{"name":"PSP XMB"}')
            (stage / 'dist/index.js').write_text('new build')
            result = remote.handle({'action': 'psp-install', 'stage': str(stage)})
            self.assertEqual((old / 'dist/index.js').read_text(), 'new build')
            self.assertEqual((pathlib.Path(result['backup']) / 'original.txt').read_text(), 'keep me')
            with self.assertRaisesRegex(ValueError, 'staging'):
                remote.handle({'action': 'psp-install', 'stage': str(home)})


if __name__ == '__main__':
    unittest.main()
