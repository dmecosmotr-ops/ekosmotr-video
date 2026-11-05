"""Fetch only fixed, hash-checked public fixtures for explicit CI smoke."""
import hashlib
from pathlib import Path
import sys
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from video.fetch_model import fetch_model

output = ROOT / 'private' / 'video-ci'
output.mkdir(parents=True, exist_ok=True)
model = output / 'yolox_nano.onnx'
fetch_model(model)
url = 'https://raw.githubusercontent.com/Megvii-BaseDetection/YOLOX/6ddff4824372906469a7fae2dc3206c7aa4bbaee/assets/dog.jpg'
with urllib.request.urlopen(url, timeout=30) as response:
    data = response.read(1024 * 1024 + 1)
if len(data) > 1024 * 1024 or hashlib.sha256(data).hexdigest() != '5a9522051c3cec2bbd2f6323fccba32e8fbf3ddcc2b3e2fd46b04c720bc6f866':
    raise ValueError('public fixture checksum mismatch')
image = output / 'dog.jpg'
image.write_bytes(data)
# These two artifacts are public fixtures; permit the unprivileged CI container
# to read them. Real configuration and footage must retain private permissions.
for artifact in (model, image):
    artifact.chmod(0o444)
print('Pinned public model and image prepared for offline smoke; no camera accessed.')
