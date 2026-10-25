# Dev image: same Node major as runtime Dockerfile, plus FFmpeg for RTSP→HLS.
FROM mcr.microsoft.com/devcontainers/javascript-node:1-20-bookworm

USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && ffmpeg -version | head -n 1

USER node
