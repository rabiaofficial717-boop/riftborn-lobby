# Riftborn lobby: matchmaking, WebRTC signaling, relay fallback and ranked ratings. The game's web build is hosted
# elsewhere and connects to wss://<this host>/ws; /health reports players, queue and matches.
#   docker build -t riftborn-lobby .
#   docker run -p 8080:8080 -v riftborn-data:/data riftborn-lobby
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
ENV PORT=8080 STATIC_DIR=off DATA_FILE=/data/players.json
EXPOSE 8080
CMD ["node", "src/server.js"]
