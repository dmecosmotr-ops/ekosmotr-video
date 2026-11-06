# Optional image only: no supplier binaries, model weights, tokens or recordings.
# Save the tested digest at deployment; tag and apt packages are not immutable.
FROM python:3.12.12-slim-bookworm
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg openjdk-17-jdk-headless ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1000 video-worker \
    && useradd --uid 1000 --gid 1000 --no-create-home video-worker \
    && mkdir -p /app /video/recordings /video/results /video/models /run/private/runtime /opt/relay /opt/vendor/classes \
    && chown -R 1000:1000 /video /run/private/runtime /opt/relay
WORKDIR /app
COPY video/requirements.txt /app/video/requirements.txt
COPY tools/requirements-diagnostic.txt /app/tools/requirements-diagnostic.txt
RUN pip install --no-cache-dir -r video/requirements.txt -r tools/requirements-diagnostic.txt
COPY video/*.py /app/video/
COPY tools/xiaomi_live_bridge.py tools/xiaomi_cloud_probe.py tools/xiaomi_shared_inventory.py tools/xiaomi_cabinet_bundle.py tools/xiaomi_sync.py tools/RelayLive.java /app/tools/
COPY deploy/video-preflight.py deploy/build-relay.sh /app/deploy/
COPY docs/YOLOX_LICENSE.txt /app/docs/YOLOX_LICENSE.txt
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 HOME=/tmp
USER 1000:1000
# An image/run without an explicit command cannot contact any camera.
CMD ["python", "-m", "video.collector", "--help"]
