# Riftborn lobby

The online lobby for [Riftborn](https://github.com/rabiaofficial717-boop): guest sign-in, casual and ranked
matchmaking, private rooms, WebRTC signaling between the two players, a relay fallback when a direct connection
fails, and Glicko-2 ratings. The game itself is hosted separately and connects to `wss://<host>/ws`.

```bash
npm ci
npm test
npm start            # ws://localhost:8080/ws, health at /health
```

Environment: `PORT` (default 8080), `DATA_FILE` (player profiles and ratings, JSON), `ICE_SERVERS` (optional
TURN/STUN servers as JSON). `STATIC_DIR=off` keeps it from serving files.

Deploy: any Docker host (`Dockerfile`), or Render (`render.yaml`).

This repository mirrors the `Server/` folder of the game's private repository, where it is developed.
