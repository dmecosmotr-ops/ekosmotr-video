# Notices and distribution boundaries

The application is an internal project prepared for its owner's review. This file does not assign a new license to the owner's code or grant rights to confidential company data.

`tools/xiaomi_cloud_probe.py` adapts the Xiaomi protocol implementation from go2rtc v1.9.15. Its complete MIT license and copyright notice are preserved in the file. Upstream: https://github.com/AlexxIT/go2rtc/tree/v1.9.15.

React, React DOM, lucide-react, Vite, pnpm, Python packages, Node.js, FFmpeg and the JDK retain their respective upstream licenses. Dependency source/binaries are not checked into this repository; use the lockfiles and the documented build process. Inspect the licenses of the actual distribution used by the company.

The external `micam.*` transport classes from the local video experiment are **not included or downloaded by this project**. Their source, distribution rights and sender validation remain unresolved; the default container does not enable that diagnostic adapter. See `docs/VIDEO_DEPLOYMENT_REVIEW.md` before considering optional live-video setup. Do not copy private vendor classes into the repository or default image.

Camera credentials, tokens, recordings, SQLite databases and local runtime files are not part of the source distribution.
