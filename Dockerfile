# Runtime image: Node.js + FFmpeg for RTSP → HLS
FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY public ./public

ENV NODE_ENV=production
ENV PORT=3000
ENV HLS_OUTPUT_DIR=/app/hls

RUN mkdir -p /app/hls && chown -R node:node /app
USER node

EXPOSE 3000

CMD ["node", "server/index.js"]
