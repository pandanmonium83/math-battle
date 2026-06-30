# Math Duel

Math Duel is a basic two-player browser game for testing mental math speed and accuracy. One player creates a room, shares the room link, and both players answer the same server-generated questions.

## Phase Plan

| Phase | Goal | Features | Definition of Done |
| --- | --- | --- | --- |
| 1. Prototype | Prove the game loop | Two-player rooms, addition/subtraction/multiplication/division/percents/powers, digit difficulty, timed rounds, scoring | Two players can join the same room and finish a match |
| 2. Classroom Ready | Make it useful with students | Better room names, teacher host controls, copyable invite links, rematch button, clearer round review | A teacher can run quick matches without explaining the app |
| 3. Skill Growth | Make practice adaptive | Difficulty ladder, mixed mode rules, weak-skill tracking, per-topic score breakdown | The game can recommend the next mode/difficulty |
| 4. Accounts | Keep long-term progress | Student logins, saved scores, win/loss history, leaderboards, class groups | Players can return later and see progress |
| 5. Production | Make it reliable online | Database, persistent rooms, reconnect support, anti-cheat checks, logging, mobile polish | The game can handle real classroom traffic |
| 6. Expansion | Make it feel like a real product | Custom match types, tournaments, avatars, team mode, teacher dashboard | It supports repeat play, not just one-off matches |

## Programming Pass: Keep the Algorithm Easy

The whole app is built around one loop:

1. Host chooses settings.
2. Server generates one question.
3. Both players receive the same prompt.
4. Each player submits one answer.
5. Server scores answers.
6. Server shows the correct answer and point breakdown.
7. Repeat until the match ends.

The scoring algorithm is intentionally separated from the UI in `scoreAnswer()` inside `server.js`.

```txt
If answer is perfect:
  correctness = 100
  perfect bonus = 25
If answer is close:
  correctness = 45 to 80, based on how close it is
If answer is outside range:
  correctness = 0

If correctness is greater than 0:
  add speed bonus from 0 to 50
  add streak bonus for perfect answers
Otherwise:
  speed bonus = 0
  final score = 0
```

That means a player who answers instantly but is far from the correct answer earns no points.

## Current Modes

| Mode | Question Example | Difficulty Rule |
| --- | --- | --- |
| Addition | `47 + 82` | Number of digits controls each addend |
| Subtraction | `82 - 47` | Larger number is placed first |
| Multiplication | `7 x 8` | Number of digits controls factors |
| Division | `72 / 8` | Server creates clean whole-number quotients |
| Percents | `25% of 84` | Uses friendly percents |
| Powers | `9^3` | Base and exponent scale gently |
| Mixed | Any mode | Random mode each question |

## Run Locally

Install Node.js 18 or newer, then run:

```bash
npm install
npm start
```

Open:

```txt
http://localhost:3000
```

To test two players on one computer, open the game in two browser windows and join the same room code.

## Put It On The Internet

This app needs a Node host because live rooms use a tiny built-in Node server with server-sent events. Static-only hosting will show the page but will not run multiplayer.

Simple deployment path:

1. Put this folder in a GitHub repository.
2. Create a new Web Service on Render, Railway, Fly.io, or another Node host.
3. Set the build command to `npm install`.
4. Set the start command to `npm start`.
5. Make sure the service uses Node 18 or newer.
6. Open the public URL and share a room link with another player.

## File Map

| File | Purpose |
| --- | --- |
| `server.js` | Hosts the game, manages rooms, generates questions, scores answers |
| `public/index.html` | Complete browser interface |
| `package.json` | Node dependencies and start scripts |
