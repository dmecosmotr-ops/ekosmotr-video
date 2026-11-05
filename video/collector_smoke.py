"""Offline container test: real FFmpeg -> collector -> real ffprobe.

No Xiaomi token, vendor dependency or camera connection is used.
"""
import hashlib
import json
from pathlib import Path
import shutil
import tempfile
import threading

from .collector import _collect


def main():
    ffmpeg, ffprobe = shutil.which('ffmpeg'), shutil.which('ffprobe')
    if not ffmpeg or not ffprobe:
        raise RuntimeError('FFmpeg and ffprobe required')
    with tempfile.TemporaryDirectory(prefix='synthetic-video-') as temporary:
        root = Path(temporary)
        archive = root / 'recordings'
        archive.mkdir()
        config = {
            'archiveRoot': str(archive), 'cameraId': 'synthetic-camera',
            'stationId': 'synthetic-station', 'mappingVersion': 'v1', 'timezone': 'UTC',
            'maxSeconds': 5, 'startupTimeoutSeconds': 10, 'stallTimeoutSeconds': 10,
            'totalTimeoutSeconds': 20, 'maxBytes': 1024 * 1024,
            'minFreeBytes': 0, 'probeTimeoutSeconds': 5,
            'ffmpeg': ffmpeg, 'decodeTimeoutSeconds': 15,
        }
        source = [ffmpeg, '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
                  '-i', 'color=c=blue:s=160x120:r=10', '-t', '1.2', '-an',
                  '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
                  '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1']
        capture = _collect(config, source, [ffprobe], threading.Event())
        recording = capture['recording']
        content = (archive / recording['file']).read_bytes()
        assert capture['status'] == 'complete' and recording['timing'] == 'estimated'
        assert .5 < recording['durationSeconds'] < 3
        assert hashlib.sha256(content).hexdigest() == recording['sha256']
        saved = json.loads((archive / capture['runId'] / 'capture.json').read_text())
        assert saved == capture
        print(json.dumps({'status': 'passed', 'source': 'synthetic-FFmpeg-lavfi',
                          'durationSeconds': recording['durationSeconds'], 'bytes': len(content),
                          'timing': recording['timing'], 'cameraAccessed': False}))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
