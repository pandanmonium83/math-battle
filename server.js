const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 8;
const RESULT_PAUSE_MS = 2200;
const BEST_GAME_LIMIT = 25;
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const LEADERBOARD_FILE = path.join(DATA_DIR, "leaderboard.json");

const rooms = new Map();
let allTimeLeaderboard = loadLeaderboard();

const defaultSettings = {
  mode: "addition",
  digits: 1,
  questions: 10,
  seconds: 12,
  nearTolerancePercent: 25,
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

function blankStats() {
  return {
    answers: 0,
    perfect: 0,
    close: 0,
    missed: 0,
    fastestMs: null,
    totalCorrectMs: 0,
  };
}

function loadLeaderboard() {
  try {
    const raw = fs.readFileSync(LEADERBOARD_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(0, BEST_GAME_LIMIT) : [];
  } catch {
    return [];
  }
}

function saveLeaderboard() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(LEADERBOARD_FILE, JSON.stringify(allTimeLeaderboard, null, 2));
  } catch (error) {
    console.warn(`Could not save leaderboard: ${error.message}`);
  }
}

function leaderboardEntryFor(player, room, rank) {
  const stats = player.stats || blankStats();
  const correct = stats.perfect + stats.close;
  const accuracy = room.settings.questions ? Math.round((correct / room.settings.questions) * 100) : 0;

  return {
    id: crypto.randomUUID(),
    name: player.name,
    score: player.score,
    rank,
    accuracy,
    perfect: stats.perfect,
    close: stats.close,
    missed: stats.missed,
    fastestMs: stats.fastestMs,
    mode: room.settings.mode,
    digits: room.settings.digits,
    questions: room.settings.questions,
    seconds: room.settings.seconds,
    nearTolerancePercent: room.settings.nearTolerancePercent,
    playedAt: new Date().toISOString(),
  };
}

function addLeaderboardEntries(entries) {
  allTimeLeaderboard = [...allTimeLeaderboard, ...entries]
    .filter((entry) => Number.isFinite(entry.score))
    .sort((a, b) => b.score - a.score || new Date(a.playedAt) - new Date(b.playedAt))
    .slice(0, BEST_GAME_LIMIT);
  saveLeaderboard();
}

function standingsFor(room) {
  return [...room.players]
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .map((player, index) => ({
      rank: index + 1,
      id: player.id,
      name: player.name,
      score: player.score,
      perfectStreak: player.perfectStreak,
      isHost: player.isHost,
    }));
}

function publicRoom(room) {
  return {
    code: room.code,
    status: room.status,
    settings: room.settings,
    questionIndex: room.questionIndex,
    maxPlayers: MAX_PLAYERS,
    standings: standingsFor(room),
    allTimeLeaderboard,
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
  const modes = ["addition", "subtraction", "multiplication", "division", "percents"];
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

  return { mode: "addition", prompt: `${a} + ${b}`, answer: a + b, answerLabel: String(a + b) };
}

function difficultyMultiplier({ mode, digits, seconds, tolerancePercent }) {
  const modeMultipliers = {
    addition: 1,
    subtraction: 1.1,
    multiplication: 1.35,
    division: 1.45,
    percents: 1.55,
    mixed: 1.25,
  };
  const digitMultipliers = {
    1: 1,
    2: 1.35,
    3: 1.8,
    4: 2.35,
  };

  const modeMultiplier = modeMultipliers[mode] || 1;
  const digitMultiplier = digitMultipliers[digits] || 1;
  const timeMultiplier = Math.min(1.6, Math.max(0.85, 12 / seconds));
  const toleranceMultiplier = Math.min(1.3, Math.max(1, 1 + (25 - tolerancePercent) / 80));

  return Number((modeMultiplier * digitMultiplier * timeMultiplier * toleranceMultiplier).toFixed(2));
}

function scoreAnswer({ guess, answer, startedAt, seconds, tolerancePercent, streak, mode, digits }) {
  const numericGuess = Number(guess);
  const multiplier = difficultyMultiplier({ mode, digits, seconds, tolerancePercent });

  if (!Number.isFinite(numericGuess)) {
    return {
      points: 0,
      basePoints: 0,
      correctnessPoints: 0,
      speedBonus: 0,
      perfectBonus: 0,
      streakBonus: 0,
      difficultyMultiplier: multiplier,
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

  const basePoints = correctnessPoints + speedBonus + perfectBonus + streakBonus;

  return {
    points: Math.round(basePoints * multiplier),
    basePoints,
    correctnessPoints,
    speedBonus,
    perfectBonus,
    streakBonus,
    difficultyMultiplier: multiplier,
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

function matchRecapFor(room, standings) {
  const winner = standings[0] || null;
  const playerRecaps = standings.map((standing) => {
    const player = findPlayer(room, standing.id);
    const stats = player?.stats || blankStats();
    const correct = stats.perfect + stats.close;
    const accuracy = room.settings.questions ? Math.round((correct / room.settings.questions) * 100) : 0;
    const averageCorrectMs = correct ? Math.round(stats.totalCorrectMs / correct) : null;

    return {
      rank: standing.rank,
      id: standing.id,
      name: standing.name,
      score: standing.score,
      accuracy,
      perfect: stats.perfect,
      close: stats.close,
      missed: stats.missed,
      fastestMs: stats.fastestMs,
      averageCorrectMs,
    };
  });

  return {
    roomCode: room.code,
    winner,
    settings: room.settings,
    completedAt: new Date().toISOString(),
    players: playerRecaps,
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
          basePoints: 0,
          correctnessPoints: 0,
          speedBonus: 0,
          perfectBonus: 0,
          streakBonus: 0,
          difficultyMultiplier: difficultyMultiplier({
            mode: room.currentQuestion.mode,
            digits: room.settings.digits,
            seconds: room.settings.seconds,
            tolerancePercent: room.settings.nearTolerancePercent,
          }),
          isPerfect: false,
          isNear: false,
          elapsedMs: room.settings.seconds * 1000,
          feedback: "No answer",
        };

    if (!submitted || !result.isPerfect) {
      player.perfectStreak = 0;
    }

    if (!player.stats) player.stats = blankStats();
    if (submitted) {
      player.stats.answers += 1;
    }

    if (result.isPerfect) {
      player.stats.perfect += 1;
      player.stats.totalCorrectMs += result.elapsedMs;
      player.stats.fastestMs =
        player.stats.fastestMs === null ? result.elapsedMs : Math.min(player.stats.fastestMs, result.elapsedMs);
    } else if (result.isNear) {
      player.stats.close += 1;
      player.stats.totalCorrectMs += result.elapsedMs;
      player.stats.fastestMs =
        player.stats.fastestMs === null ? result.elapsedMs : Math.min(player.stats.fastestMs, result.elapsedMs);
    } else {
      player.stats.missed += 1;
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
    const standings = standingsFor(room);
    const recap = matchRecapFor(room, standings);
    const entries = standings
      .map((standing) => {
        const player = findPlayer(room, standing.id);
        return player ? leaderboardEntryFor(player, room, standing.rank) : null;
      })
      .filter(Boolean);
    addLeaderboardEntries(entries);

    setTimeout(() => {
      broadcast(room, "game:over", { standings, recap, allTimeLeaderboard });
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
    player.stats = blankStats();
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
    return { status: 409, payload: { error: `This room already has ${MAX_PLAYERS} players.` } };
  }

  if (!player) {
    player = {
      id: crypto.randomUUID(),
      name: displayName,
      score: 0,
      perfectStreak: 0,
      stats: blankStats(),
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
    mode: room.currentQuestion.mode,
    digits: room.settings.digits,
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
