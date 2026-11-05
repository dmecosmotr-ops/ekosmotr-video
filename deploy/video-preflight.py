"""Offline dependency check only: no provisioning, download, camera, or token use."""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys

VENDOR_CLASSES = ('micam/miss/MediaPacket.class', 'micam/miss/MissClient.class',
    'micam/miss/MissCrypto.class', 'micam/pppp/InitString.class',
    'micam/pppp/PpppConnection.class', 'micam/pppp/RelaySession.class', 'micam/pppp/Uid.class')


def version(command: list[str]) -> str:
    result = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT, timeout=10, check=False, shell=False)
    if result.returncode or len(result.stdout) > 32768:
        raise ValueError('DEPENDENCY_CHECK_FAILED')
    return result.stdout.decode('utf-8', errors='replace')


def check(args) -> dict:
    if sys.version_info < (3, 11):
        raise ValueError('PYTHON_TOO_OLD')
    classes = args.vendor_classes
    if not classes.is_absolute() or not classes.is_dir() or classes.is_symlink():
        raise ValueError('VENDOR_CLASSES_MISSING')
    if any(not (classes / name).is_file() or (classes / name).is_symlink() for name in VENDOR_CLASSES):
        raise ValueError('VENDOR_CLASSES_MISSING')
    file = args.bridge_config
    if (not file.is_absolute() or file.is_symlink() or not file.is_file()
            or file.stat().st_size > 32768
            or 'private' not in {p.lower() for p in file.parts[:-1]}):
        raise ValueError('INVALID_PRIVATE_CONFIG')
    config = json.loads(file.read_text(encoding='utf-8-sig'))
    for key in ('java', 'ffmpeg', 'cloudTools', 'pythonDeps', 'privateRoot', 'go2rtcConfig'):
        if not isinstance(config.get(key), str) or not Path(config[key]).is_absolute():
            raise ValueError('INVALID_DEPENDENCY_PATH')
    java = Path(config['java'])
    javac = java.with_name('javac.exe' if os.name == 'nt' else 'javac')
    java_version = version([str(java), '-version'])
    compiler_version = version([str(javac), '-version'])
    match = re.search(r'version "(\d+)', java_version)
    compiler = re.search(r'javac (\d+)', compiler_version)
    if not match or not compiler or min(int(match[1]), int(compiler[1])) < 17:
        raise ValueError('JDK_17_REQUIRED')
    if not version([config['ffmpeg'], '-version']).startswith('ffmpeg version'):
        raise ValueError('FFMPEG_UNAVAILABLE')
    probe = args.ffprobe or Path(config['ffmpeg']).with_name('ffprobe.exe' if os.name == 'nt' else 'ffprobe')
    if not version([str(probe), '-version']).startswith('ffprobe version'):
        raise ValueError('FFPROBE_UNAVAILABLE')
    if args.collector_config is not None:
        # Fixed local module, offline validation only. No bridge provisioning.
        spec = importlib.util.spec_from_file_location('collector_preflight',
            Path(__file__).resolve().parents[1] / 'video' / 'collector.py')
        collector = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(collector)
        capture_config = collector.load_config(args.collector_config)
        if not version([capture_config['ffmpeg'], '-version']).startswith('ffmpeg version'):
            raise ValueError('FFMPEG_UNAVAILABLE')
        if not version([capture_config['ffprobe'], '-version']).startswith('ffprobe version'):
            raise ValueError('FFPROBE_UNAVAILABLE')
    for name in VENDOR_CLASSES:
        path = classes / name
        if path.is_symlink() or not path.is_file():
            raise ValueError('VENDOR_CLASSES_MISSING')
        with path.open('rb') as stream:
            header = stream.read(8)
        if header[:4] != b'\xca\xfe\xba\xbe' or len(header) != 8:
            raise ValueError('INVALID_VENDOR_CLASS')
        if int.from_bytes(header[6:8], 'big') > int(match[1]) + 44:
            raise ValueError('VENDOR_BYTECODE_TOO_NEW')
    classpath = config.get('javaClasses')
    if not isinstance(classpath, str) or not classpath:
        raise ValueError('INVALID_JAVA_CLASSPATH')
    directories = [Path(p) for p in classpath.split(os.pathsep)]
    if not all(p.is_absolute() and p.is_dir() for p in directories) or classes.resolve() not in [p.resolve() for p in directories]:
        raise ValueError('INVALID_JAVA_CLASSPATH')
    if not any((p / 'RelayLive.class').is_file() for p in directories):
        raise ValueError('RELAY_BUILD_REQUIRED')
    if not (Path(config['cloudTools']) / 'xiaomi_cloud_probe.py').is_file():
        raise ValueError('CLOUD_HELPER_MISSING')
    # Import package metadata only. Never import/run the cloud helper or read the token.
    sys.path.insert(0, config['pythonDeps'])
    if not all(importlib.util.find_spec(module) is not None for module in ('nacl', 'yaml')):
        raise ValueError('PYTHON_DEPENDENCIES_MISSING')
    private_root = Path(config['privateRoot'])
    token = Path(config['go2rtcConfig'])
    if 'private' not in {p.lower() for p in private_root.parts} or not private_root.is_dir() or not os.access(private_root, os.W_OK):
        raise ValueError('PRIVATE_RUNTIME_NOT_WRITABLE')
    if 'private' not in {p.lower() for p in token.parts[:-1]} or not token.is_file() or not os.access(token, os.R_OK):
        raise ValueError('AUTHORIZATION_FILE_UNAVAILABLE')
    return {'status': 'dependencies-present', 'python': '.'.join(map(str, sys.version_info[:3])),
        'jdkMajor': int(match[1]), 'cameraConnection': 'not-tested', 'vendorSafety': 'not-established'}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bridge-config', type=Path, required=True)
    parser.add_argument('--vendor-classes', type=Path, required=True)
    parser.add_argument('--ffprobe', type=Path)
    parser.add_argument('--collector-config', type=Path,
        help='Also validate collector dependency paths and bounded decode timeout offline')
    args = parser.parse_args()
    try:
        print(json.dumps(check(args)))
        return 0
    except ValueError as failure:
        code = str(failure)
        # JSON/codec and subprocess exceptions must never leak config or upstream text.
        print(code if re.fullmatch(r'[A-Z][A-Z_]{2,63}', code) else 'PREFLIGHT_FAILED', file=sys.stderr)
    except Exception:
        print('PREFLIGHT_FAILED', file=sys.stderr)
    return 2


if __name__ == '__main__':
    raise SystemExit(main())
