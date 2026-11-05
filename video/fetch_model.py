"""Explicit, separate download of the official YOLOX Nano ONNX release.

No downloader is called by the analysis process. Keep weights out of Git/images.
"""
import argparse
import hashlib
import os
from pathlib import Path
import tempfile
import urllib.request

MODEL_URL = 'https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_nano.onnx'
MODEL_SHA256 = 'c789161ed43c8269fcd4e67c67eeeb4e80c622da2eb296a20bc6007bd18a0b7d'
MODEL_BYTES = 3659407


def verify_model(path):
    path = Path(path)
    if path.is_symlink() or not path.is_file() or path.stat().st_size != MODEL_BYTES:
        raise ValueError('expected official YOLOX Nano ONNX file')
    if hashlib.sha256(path.read_bytes()).hexdigest() != MODEL_SHA256:
        raise ValueError('YOLOX Nano SHA256 mismatch')
    return path


def fetch_model(destination):
    destination = Path(destination)
    if destination.exists() or destination.is_symlink():
        verify_model(destination)
        return destination
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        request = urllib.request.Request(MODEL_URL, headers={'User-Agent': 'ekosmotr-video-pilot-model-fetch/1'})
        with urllib.request.urlopen(request, timeout=60) as response:
            if not response.geturl().startswith('https://'):
                raise ValueError('non-HTTPS model redirect')
            with tempfile.NamedTemporaryFile(dir=destination.parent, prefix='.model-', suffix='.tmp', delete=False) as stream:
                temporary = Path(stream.name)
                received = 0
                while True:
                    block = response.read(128 * 1024)
                    if not block:
                        break
                    received += len(block)
                    if received > MODEL_BYTES:
                        raise ValueError('model exceeds pinned file size')
                    stream.write(block)
                stream.flush()
                os.fsync(stream.fileno())
        verify_model(temporary)
        if os.name == 'nt':
            os.rename(temporary, destination)
        else:
            os.link(temporary, destination)
        return destination
    finally:
        if temporary:
            temporary.unlink(missing_ok=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True, help='private path for pinned ONNX model')
    args = parser.parse_args(argv)
    try:
        fetch_model(args.output)
    except (ValueError, OSError):
        parser.exit(1, 'Official model download/verification failed. No model accepted.\n')
    print(f'YOLOX Nano verified: sha256={MODEL_SHA256} bytes={MODEL_BYTES}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
