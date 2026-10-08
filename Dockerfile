# Luma container image. Railway builds this automatically (see railway.json).
FROM node:22-slim

# ffprobe gives exact video/song lengths for every format (the 15-minute reel limit).
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

# Railway routes its public domain to $PORT (8080 unless you change it). Default to the
# same port so the domain, the container and the app always agree.
ENV PORT=8080
EXPOSE 8080

# Runs as root so the app can write to a Railway volume, which is mounted root-owned.
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
