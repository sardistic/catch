FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates ffmpeg python3 python3-pip \
  && python3 -m pip install --no-cache-dir --break-system-packages yt-dlp \
  && apt-get purge -y python3-pip \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --chown=node:node package.json ./
COPY --chown=node:node server.js ./
COPY --chown=node:node public ./public

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
