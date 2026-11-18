"""Send the active Steam Deck screen as multipart JPEG over an SSH channel."""

import os
import select
import shutil
import subprocess
import sys


def session_property(*args):
    result = subprocess.run(['loginctl', *args], capture_output=True, text=True, timeout=3)
    return result.stdout.strip()


def video_source():
    # An SSH login has its own session. Ask logind about the physical display.
    seat = session_property('show-seat', 'seat0', '-p', 'ActiveSession', '--value')
    if seat:
        properties = session_property('show-session', seat, '-p', 'User', '-p', 'Type', '-p', 'Display', '-p', 'Desktop')
        session = dict(line.split('=', 1) for line in properties.splitlines() if '=' in line)
        if session.get('User') != str(os.getuid()):
            raise ValueError('Для просмотра войдите по SSH под пользователем активного экрана Deck.')
        if session.get('Type') == 'x11':
            env = subprocess.run(['systemctl', '--user', 'show-environment'], capture_output=True, text=True, timeout=3)
            desktop = dict(line.split('=', 1) for line in env.stdout.splitlines() if '=' in line)
            display = session.get('Display') or desktop.get('DISPLAY')
            if not display:
                raise ValueError('Рабочий стол X11 не сообщил адрес экрана.')
            if desktop.get('XAUTHORITY'):
                os.environ['XAUTHORITY'] = desktop['XAUTHORITY']
            os.environ['GST_XINITTHREADS'] = '1'
            return ['ximagesrc', 'display-name=' + display, '!', 'video/x-raw,framerate=20/1']
        if session.get('Desktop') and 'gamescope' not in session['Desktop'].lower():
            raise ValueError('Для просмотра вернитесь в игровой режим Steam Deck или откройте рабочий стол X11.')
    # Target Gamescope explicitly so PipeWire never selects a camera.
    return ['pipewiresrc', 'target-object=gamescope', 'do-timestamp=true']


def main():
    if not shutil.which('gst-launch-1.0'):
        raise ValueError('На Deck не найден GStreamer (gst-launch-1.0).')
    os.environ['XDG_RUNTIME_DIR'] = '/run/user/' + str(os.getuid())
    command = ['gst-launch-1.0', '-q', *video_source(),
               '!', 'videorate', 'drop-only=true', '!', 'video/x-raw,framerate=20/1',
               '!', 'queue', 'leaky=downstream', 'max-size-buffers=1',
               '!', 'videoconvert', '!', 'videoscale',
               '!', 'video/x-raw,width=960,height=600,pixel-aspect-ratio=1/1',
               '!', 'jpegenc', 'quality=75', '!', 'multipartmux', 'boundary=deckframe',
               '!', 'fdsink', 'fd=1', 'sync=false']
    with subprocess.Popen(command, stdin=subprocess.DEVNULL) as capture:
        try:
            while capture.poll() is None:
                readable, _, _ = select.select([sys.stdin.buffer], [], [], 0.5)
                if readable and not os.read(0, 1):
                    return 0
        finally:
            if capture.poll() is None:
                capture.terminate()
                try:
                    capture.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    capture.kill()
    return capture.returncode


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        sys.exit(str(error))
