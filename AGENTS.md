# Cabinet for PTO cameras

This repository contains the separate camera pilot. Do not mix it with the speech/microphone analysis project. It includes a cabinet with server-side roles/scoped access and an optional bounded collector plus preliminary offline CPU video analysis. See docs/VIDEO_PIPELINE_RESULT_2026_11_05.md. Real PTO accuracy, company Linux camera reception and continuous recording are unaccepted work; do not describe test footage as business acceptance.

## Changes and deployment

- Read `README.md`, `CONTRACT.md`, `docs/SERVER_DEPLOYMENT.md` and `docs/VIDEO_DEPLOYMENT_REVIEW.md` for the relevant area.
- Show a concrete plan before changing working code. Keep the existing UI and server rights working. Use independent review for security or deployment changes.
- GitHub/CI is for review and testing. The company's programmer deploys. Do not add automatic deployment, SSH connections, Docker host privileges or mounts into other services without explicit authorization.
- Local mode contains public fixture logins. Server mode must stay fail-closed, use a mounted administrator secret, a precise HTTPS origin and Secure cookies. Never make test shortcuts available by default in server mode.
- Do not trust forwarded headers as a replacement for the configured origin or actual peer address. Do not weaken authentication to pass a smoke test.

## Data and video

- Never commit `private/`, credentials, Xiaomi session material, raw camera IDs/connection URLs, recordings, databases, runtime binaries or logs. Check `node tools/check-release.mjs` against the index before publishing.
- Server scoping is authoritative. A single-camera grant must not reveal other cameras or their aggregate events; a director cannot delegate beyond their scope.
- Keep real and example data separate. Missing analysis is not zero cars or a closed station. A person is not an identified expert; entries are not unique customers.
- Do not use experts' PCs for video collection. Do not silently enable all streams or continuous recording.
- Preserve the MIT notice in `tools/xiaomi_cloud_probe.py`. External `micam.*` binaries are not included; do not distribute or automatically download them while their license and safety checks remain unresolved.

## Verification

- Node 24: `node --test tests/*.test.mjs frontend/*.test.mjs deploy/*.test.mjs` from repository root after frontend dependencies are installed.
- Python: `python -m unittest discover -s tests -p 'test_*.py'`; use the optional video environment for OpenCV/ONNX tests and actual FFmpeg for receiver integrity checks. State skips.
- Build: `pnpm --dir frontend install --frozen-lockfile`, then `pnpm --dir frontend run build` with pinned pnpm 10.28.2.
- Windows with existing dependencies: `build-pilot.ps1` calls Vite directly.
- UI changes need browser desktop/mobile checks. Container claims need an actual Docker/CI run; passing Windows tests alone does not establish Linux readiness.
