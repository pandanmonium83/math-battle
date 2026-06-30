const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 2;
const RESULT_PAUSE_MS = 2200;
const PUBLIC_DIR = path.join(__dirname, "public");

const rooms = new Map();

const defaultSettings = {
  mode: "addition",
  digits: 1,
  questions: 10,
  seconds: 12,
  nearTolerancePercent: 10,
};

function makeRoom(code) {
  return {
    code,
    players: [],
    clients: new Map(),
    settings: { ...defaultSettings },
    status: "lobby",
    questionIndex: 0,
    currentQuestion: null,
    answers: new Map(),
    roundTimer: null,
  };
}

function publicRoom(room) {
  return {
    code: room.code,
    status: room.status,
    settings: room.settings,
    questionIndex: room.questionIndex,
    players: room.players.map((player) => ({
      id: player.id,
      name: player.name,
      score: player.score,
      perfectStreak: player.perfectStreak,
      isHost: player.isHost,
    })),
  };
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function sanitizeSettings(raw = {}) {
  const allowedModes = new Set([
    "addition",
    "subtraction",
    "multiplication",
    "division",
    "percents",
    "powers",
    "mixed",
  ]);

  return {
    mode: allowedModes.has(raw.mode) ? raw.mode : defaultSettings.mode,
    digits: clampNumber(raw.digits, 1, 4, defaultSettings.digits),
    questions: clampNumber(raw.questions, 3, 30, defaultSettings.questions),
    seconds: clampNumber(raw.seconds, 5, 30, defaultSettings.seconds),
    nearTolerancePercent: clampNumber(
      raw.nearTolerancePercent,
      1,
      25,
      defaultSettings.nearTolerancePercent
    ),
  };
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function numberWithDigits(digits) {
  if (digits === 1) return randomInt(1, 9);
  return randomInt(10 ** (digits - 1), 10 ** digits - 1);
}

function formatNumber(value) {
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toFixed(4)));
}

function chooseMode(mode) {
  if (mode !== "mixed") return mode;
  const modes = ["addition", "subtraction", "multiplication", "division", "percents", "powers"];
  return modes[randomInt(0, modes.length - 1)];
}

function generateQuestion(settings) {
  const mode = chooseMode(settings.mode);
  const digits = settings.digits;
  const a = numberWithDigits(digits);
  const b = numberWithDigits(digits);

  if (mode === "addition") {
    return { mode, prompt: `${a} + ${b}`, answer: a + b, answerLabel: String(a + b) };
  }

  if (mode === "subtraction") {
    const high = Math.max(a, b);
    const low = Math.min(a, b);
    return { mode, prompt: `${high} - ${low}`, answer: high - low, answerLabel: String(high - low) };
  }

  if (mode === "multiplication") {
    return { mode, prompt: `${a} x ${b}`, answer: a * b, answerLabel: String(a * b) };
  }

  if (mode === "division") {
    const divisor = numberWithDigits(Math.min(digits, 2));
    const quotient = numberWithDigits(digits);
    const dividend = divisor * quotient;
    return { mode, prompt: `${dividend} / ${divisor}`, answer: quotient, answerLabel: String(quotient) };
  }

  if (mode === "percents") {
    const friendlyPercents = [5, 10, 12.5, 20, 25, 40, 50, 75];
    const percent = friendlyPercents[randomInt(0, friendlyPercents.length - 1)];
    const base = numberWithDigits(digits) * 4;
    const answer = (percent / 100) * base;
    return { mode, prompt: `${percent}% of ${base}`, answer, answerLabel: formatNumber(answer) };
  }

  const base = numberWithDigits(Math.min(digits, 2));
  const exponent = randomInt(2, Math.min(5, digits + 2));
  const answer = base ** exponent;
  return { mode: "powers", prompt: `${base}^${exponent}`, answer, answerLabel: String(answer) };
}

function scoreAnswer({ guess, answer, startedAt, seconds, tolerancePercent, streak }) {
  const numericGuess = Number(guess);
  if (!Number.isFinite(numericGuess)) {
    return {
      points: 0,
      correctnessPoints: 0,
      speedBonus: 0,
      perfectBonus: 0,
      streakBonus: 0,
      isPerfect: false,
      isNear: false,
      elapsedMs: Date.now() - startedAt,
      feedback: "Not a number",
    };
  }

  const elapsedMs = Math.max(0, Date.now() - startedAt);
  const allowedTimeMs = seconds * 1000;
  const absoluteError = Math.abs(numericGuess - answer);
  const exactWindow = Math.max(0.0001, Math.abs(answer) * 0.0001);
  const nearWindow = Math.max(1, Math.abs(answer) * (tolerancePercent / 100));

  const isPerfect = absoluteError <= exactWindow;
  const isNear = !isPerfect && absoluteError <= nearWindow;

  let correctnessPoints = 0;
  let perfectBonus = 0;
  let feedback = "Outside range";

  if (isPerfect) {
    correctnessPoints = 100;
    perfectBonus = 25;
    feedback = "Perfect";
  } else if (isNear) {
    const closeness = 1 - absoluteError / nearWindow;
    correctnessPoints = Math.round(45 + 35 * closeness);
    feedback = "Close";
  }

  let speedBonus = 0;
  let streakBonus = 0;

  if (correctnessPoints > 0) {
    const remainingRatio = Math.max(0, (allowedTimeMs - elapsedMs) / allowedTimeMs);
    speedBonus = Math.round(50 * remainingRatio);
    streakBonus = isPerfect ? Math.min(30, streak * 5) : 0;
  }

  return {
    points: correctnessPoints + speedBonus + perfectBonus + streakBonus,
    correctnessPoints,
    speedBonus,
    perfectBonus,
    streakBonus,
    isPerfect,
    isNear,
    elapsedMs,
    feedback,
  };
}

function sendEvent(res, type, payload) {
  res.write(`event: ${type}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcast(room, type, payload) {
  room.clients.forEach((res) => sendEvent(res, type, payload));
}

function emitRoom(room) {
  broadcast(room, "room:update", publicRoom(room));
}

function currentQuestionForClient(room) {
  return {
    number: room.questionIndex,
    total: room.settings.questions,
    prompt: room.currentQuestion.prompt,
    mode: room.currentQuestion.mode,
    seconds: room.settings.seconds,
    startedAt: room.currentQuestion.startedAt,
  };
}

function beginQuestion(room) {
  room.answers.clear();
  room.questionIndex += 1;
  room.currentQuestion = {
    ...generateQuestion(room.settings),
    startedAt: Date.now(),
  };

  broadcast(room, "game:question", currentQuestionForClient(room));
  emitRoom(room);

  room.roundTimer = setTimeout(() => settleQuestion(room), room.settings.seconds * 1000);
}

function settleQuestion(room) {
  if (room.status !== "playing" || !room.currentQuestion) return;

  if (room.roundTimer) {
    clearTimeout(room.roundTimer);
    room.roundTimer = null;
  }

  const results = room.players.map((player) => {
    const submitted = room.answers.get(player.id);
    const result = submitted
      ? submitted.result
      : {
          points: 0,
          correctnessPoints: 0,
          speedBonus: 0,
          perfectBonus: 0,
          streakBonus: 0,
          isPerfect: false,
          isNear: false,
          elapsedMs: room.settings.seconds * 1000,
          feedback: "No answer",
        };

    if (!submitted || !result.isPerfect) {
      player.perfectStreak = 0;
    }

    player.score += result.points;

    return {
      playerId: player.id,
      name: player.name,
      guess: submitted ? submitted.guess : "",
      ...result,
      score: player.score,
    };
  });

  broadcast(room, "game:result", {
    questionNumber: room.questionIndex,
    correctAnswer: room.currentQuestion.answerLabel,
    results,
  });

  emitRoom(room);

  if (room.questionIndex >= room.settings.questions) {
    room.status = "finished";
    const standings = [...room.players]
      .sort((a, b) => b.score - a.score)
      .map((player, index) => ({ rank: index + 1, id: player.id, name: player.name, score: player.score }));

    setTimeout(() => {
      broadcast(room, "game:over", { standings });
      emitRoom(room);
    }, RESULT_PAUSE_MS);
    return;
  }

  setTimeout(() => beginQuestion(room), RESULT_PAUSE_MS);
}

function resetScores(room) {
  room.players.forEach((player) => {
    player.score = 0;
    player.perfectStreak = 0;
  });
  room.questionIndex = 0;
  room.currentQuestion = null;
  room.answers.clear();
}

function getRoom(code) {
  const cleanCode = String(code || "MATH").trim().toUpperCase().slice(0, 12) || "MATH";
  if (!rooms.has(cleanCode)) {
    rooms.set(cleanCode, makeRoom(cleanCode));
  }
  return rooms.get(cleanCode);
}

function findPlayer(room, playerId) {
  return room.players.find((player) => player.id === playerId);
}

function pruneLobbyPlayers(room) {
  if (room.status === "playing") return;
  const cutoff = Date.now() - 2 * 60 * 1000;
  room.players = room.players.filter((player) => room.clients.has(player.id) || player.lastSeen > cutoff);
  if (room.players[0]) room.players[0].isHost = true;
}

function handleJoin(body) {
  const room = getRoom(body.roomCode);
  pruneLobbyPlayers(room);

  const requestedId = String(body.playerId || "");
  const displayName = String(body.name || "Player").trim().slice(0, 18) || "Player";
  let player = requestedId ? findPlayer(room, requestedId) : null;

  if (!player && room.players.length >= MAX_PLAYERS) {
    return { status: 409, payload: { error: "This room already has two players." } };
  }

  if (!player) {
    player = {
      id: crypto.randomUUID(),
      name: displayName,
      score: 0,
      perfectStreak: 0,
      isHost: room.players.length === 0,
      lastSeen: Date.now(),
    };
    room.players.push(player);
  }

  player.name = displayName;
  player.lastSeen = Date.now();
  if (!room.players.some((p) => p.isHost)) {
    room.players[0].isHost = true;
  }

  emitRoom(room);
  return { status: 200, payload: { player: { id: player.id, isHost: player.isHost }, room: publicRoom(room) } };
}

function handleSettings(body) {
  const room = rooms.get(String(body.roomCode || "").toUpperCase());
  if (!room || room.status !== "lobby") return { status: 404, payload: { error: "Room not found." } };

  const player = findPlayer(room, body.playerId);
  if (!player?.isHost) return { status: 403, payload: { error: "Only the host can change settings." } };

  room.settings = sanitizeSettings(body.settings);
  emitRoom(room);
  return { status: 200, payload: { ok: true } };
}

function handleStart(body) {
  const room = rooms.get(String(body.roomCode || "").toUpperCase());
  if (!room || room.status === "playing") return { status: 404, payload: { error: "Room not ready." } };

  const player = findPlayer(room, body.playerId);
  if (!player?.isHost) return { status: 403, payload: { error: "Only the host can start." } };

  resetScores(room);
  room.status = "playing";
  beginQuestion(room);
  return { status: 200, payload: { ok: true } };
}

function handleAnswer(body) {
  const room = rooms.get(String(body.roomCode || "").toUpperCase());
  if (!room || room.status !== "playing" || !room.currentQuestion) {
    return { status: 400, payload: { error: "No active question." } };
  }

  if (room.answers.has(body.playerId)) {
    return { status: 200, payload: { ok: true, duplicate: true } };
  }

  const player = findPlayer(room, body.playerId);
  if (!player) return { status: 404, payload: { error: "Player not found." } };

  const result = scoreAnswer({
    guess: body.answer,
    answer: room.currentQuestion.answer,
    startedAt: room.currentQuestion.startedAt,
    seconds: room.settings.seconds,
    tolerancePercent: room.settings.nearTolerancePercent,
    streak: player.perfectStreak,
  });

  if (result.isPerfect) {
    player.perfectStreak += 1;
  }

  room.answers.set(player.id, { guess: String(body.answer).trim(), result });

  if (room.clients.has(player.id)) {
    sendEvent(room.clients.get(player.id), "answer:accepted", result);
  }

  if (room.answers.size >= room.players.length) {
    settleQuestion(room);
  }

  return { status: 200, payload: { ok: true, result } };
}

function handleReset(body) {
  const room = rooms.get(String(body.roomCode || "").toUpperCase());
  if (!room) return { status: 404, payload: { error: "Room not found." } };

  const player = findPlayer(room, body.playerId);
  if (!player?.isHost) return { status: 403, payload: { error: "Only the host can reset." } };

  if (room.roundTimer) clearTimeout(room.roundTimer);
  room.status = "lobby";
  resetScores(room);
  emitRoom(room);
  return { status: 200, payload: { ok: true } };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 100_000) {
        req.destroy();
        reject(new Error("Request too large."));
      }
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, requestedPath));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const ext = path.extname(filePath);
    const contentType = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
    }[ext] || "application/octet-stream";

    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  });
}

function openEventStream(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const room = rooms.get(String(url.searchParams.get("room") || "").toUpperCase());
  const playerId = url.searchParams.get("playerId");

  if (!room || !findPlayer(room, playerId)) {
    res.writeHead(404);
    res.end("Room or player not found.");
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": connected\n\n");

  room.clients.set(playerId, res);
  sendEvent(res, "room:update", publicRoom(room));
  if (room.status === "playing" && room.currentQuestion) {
    sendEvent(res, "game:question", currentQuestionForClient(room));
  }

  req.on("close", () => {
    if (room.clients.get(playerId) === res) {
      room.clients.delete(playerId);
      const player = findPlayer(room, playerId);
      if (player) player.lastSeen = Date.now();
    }
  });
}

async function handleApi(req, res) {
  try {
    const body = await readJson(req);
    const route = new URL(req.url, `http://${req.headers.host}`).pathname;
    const handlers = {
      "/api/join": handleJoin,
      "/api/settings": handleSettings,
      "/api/start": handleStart,
      "/api/answer": handleAnswer,
      "/api/reset": handleReset,
    };
    const handler = handlers[route];
    if (!handler) return sendJson(res, 404, { error: "Unknown API route." });
    const result = handler(body);
    return sendJson(res, result.status, result.payload);
  } catch (error) {
    return sendJson(res, 400, { error: error.message });
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/events") {
    openEventStream(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname.startsWith("/api/")) {
    handleApi(req, res);
    return;
  }

  if (req.method === "GET") {
    serveStatic(req, res);
    return;
  }

  res.writeHead(405);
  res.end("Method not allowed");
});

server.listen(PORT, () => {
  console.log(`Math Duel running at http://localhost:${PORT}`);
});
