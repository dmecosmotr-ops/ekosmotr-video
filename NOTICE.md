# Notices and distribution boundaries

The application is an internal project prepared for its owner's review. This file does not assign a new license to the owner's code or grant rights to confidential company data.

`tools/xiaomi_cloud_probe.py` adapts the Xiaomi protocol implementation from go2rtc v1.9.15. Its complete MIT license and copyright notice are preserved in the file. Upstream: https://github.com/AlexxIT/go2rtc/tree/v1.9.15.

React, React DOM, lucide-react, Vite, pnpm, Python packages, Node.js, FFmpeg and the JDK retain their respective upstream licenses. Dependency source/binaries are not checked into this repository; use the lockfiles and the documented build process. Inspect the licenses of the actual distribution used by the company.

The external `micam.*` transport classes from the local video experiment are **not included or downloaded by this project**. Their source, distribution rights and sender validation remain unresolved; the default container does not enable that diagnostic adapter. See `docs/VIDEO_DEPLOYMENT_REVIEW.md` before considering optional live-video setup. Do not copy private vendor classes into the repository or default image.

Camera credentials, tokens, recordings, SQLite databases and local runtime files are not part of the source distribution.

`video/detector.py` adapts YOLOX preprocessing, grid decoding and box conversion from Megvii-BaseDetection/YOLOX at commit `6ddff4824372906469a7fae2dc3206c7aa4bbaee`: `yolox/data/data_augment.py`, `yolox/utils/demo_utils.py` and `demo/ONNXRuntime/onnx_inference.py`. Copyright (c) Megvii, Inc. and its affiliates. These portions retain Apache-2.0; a complete copy is in `docs/YOLOX_LICENSE.txt`. Modifications provide a small optional CPU inference wrapper, validated shapes, selected classes and project-specific outputs. The official Nano ONNX asset is fetched separately from release `0.1.1rc0` and checked against SHA-256 `c789161ed43c8269fcd4e67c67eeeb4e80c622da2eb296a20bc6007bd18a0b7d`; weights are not distributed in this repository. This notice does not assign the owner's application code a new license.
