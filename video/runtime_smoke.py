"""Explicit functional smoke using only the hash-pinned public YOLOX image.

Never point this smoke at real camera footage. Image/model are fetched separately
by the operator or CI; this module has no network operations.
"""
import argparse
import hashlib
import importlib.metadata
import json
from pathlib import Path
import time

from .detector import YoloXDetector
from .fetch_model import MODEL_SHA256

IMAGE_SHA256 = '5a9522051c3cec2bbd2f6323fccba32e8fbf3ddcc2b3e2fd46b04c720bc6f866'


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', required=True, type=Path)
    parser.add_argument('--image', required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        data = args.image.read_bytes()
        if len(data) > 1024 * 1024 or hashlib.sha256(data).hexdigest() != IMAGE_SHA256:
            raise ValueError('expected pinned public fixture')
        import cv2
        import numpy as np
        image = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
        if image is None:
            raise ValueError('fixture decode failed')
        started = time.perf_counter()
        detector = YoloXDetector(args.model)
        initialized = time.perf_counter()
        detections = detector.detect(image)
        ended = time.perf_counter()
        if not any(item.class_name == 'car' and item.confidence >= .35 for item in detections):
            raise ValueError('expected car not detected')
        print(json.dumps({
            'status': 'passed', 'fixture': 'official-public-dog.jpg',
            'modelSha256': MODEL_SHA256, 'imageSha256': IMAGE_SHA256,
            'packages': {name: importlib.metadata.version(name) for name in ('numpy', 'opencv-python-headless', 'onnxruntime')},
            'initializationSeconds': initialized - started, 'inferenceSeconds': ended - initialized,
            'classes': sorted({item.class_name for item in detections}),
            'note': 'Functional CPU smoke only; not PTO accuracy or network capacity.'
        }))
        return 0
    except (ValueError, OSError, ImportError, RuntimeError):
        print(json.dumps({'status': 'failed', 'message': 'public model inference smoke failed'}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
