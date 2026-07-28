# 🎮 Game Hub

Seven games in one page. **No frameworks, no build step, no dependencies, no assets** — just HTML, CSS and JavaScript. Every graphic is drawn in code; every sound is synthesised at runtime.

## Games

| Game | Modes |
|---|---|
| ⭕ **Tic-Tac-Toe** | vs AI (3 levels) or 2 players · boards from 3×3 to 10×10 |
| 🔴 **Connect Four** | vs AI (minimax + alpha-beta) or 2 players |
| 🧠 **Memory Match** | 8 to 24 pairs, against the clock |
| 🔢 **2048** | slide and merge, keyboard / swipe / d-pad |
| 🐍 **Snake** | four speeds, higher speed scores more per apple |
| 💣 **Minesweeper** | four sizes, first click always safe |
| 🏎️ **Speed Rush 3D** | single player, split screen, or **online** |

## Speed Rush 3D

A pseudo-3D racer written from scratch on a 2D canvas.

- **Perspective road renderer** — the track is thousands of segments with curve and height, projected from a camera and painted near-to-far with hill clipping
- **6-speed gearbox**, automatic or manual (`1`–`6`, `Q`/`E`), with a torque curve, rev limiter and engine braking
- **Grip limits** — exceed them and the car understeers, smokes its tyres and scrubs speed
- **Slipstream**, weight transfer, camera pitch under braking, and impact shake
- **Procedural audio** — engine note driven by revs, tyre scrub, turbo, impacts
- **Procedural textures** — asphalt grain, terrain noise, carbon fibre, metallic paint flake
- 6 cars with distinct speed / acceleration / grip / turbo, 3 tracks, 4 AI rivals, minimap, live 1st–5th positions

### Controls

| Key | Action |
|---|---|
| `W` `A` `S` `D` / arrows | Drive |
| `Shift` / `Space` | Turbo |
| `1`–`6` | Select gear (switches to manual) |
| `Q` / `E` | Shift down / up |
| `G` | Back to automatic |
| `C` | Camera distance |
| `M` | Sound on/off |

Split screen: P1 uses `WASD` + `Shift`, P2 uses the arrow keys + `Right Shift`.

## Online play

There is **no server in this project**. Online races connect the two browsers directly over WebRTC. The only job a server usually does is pass the initial connection descriptions between peers — here the players do that by copying one code each. A public STUN server is listed for address discovery only; no game data passes through it.

Both devices need the page loaded first — open this GitHub Pages URL on each.

## Running locally

Open `index.html` in a browser. For online play and reliable saved records, serve it over HTTP instead:

```sh
npx serve .        # or: python -m http.server 8000
```

## Files

```
index.html      all screens
style.css       styles + per-game themes
shared.js       screen router, HUD, saved records, round clock
net.js          WebRTC peer-to-peer transport
tictactoe.js  connect4.js  memory.js  game2048.js  snake.js  minesweeper.js  race.js
```

Records are kept in `localStorage`, per game and per difficulty.
