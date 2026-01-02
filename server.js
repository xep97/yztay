const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const games = {};
const MAX_PLAYERS = 10;

const CATEGORIES = [
  "ones","twos","threes","fours","fives","sixes",
  "pair","twoPairs","threeKind","fourKind",
  "smallStraight","largeStraight","fullHouse",
  "chance","yatzy"
];

function generateCode() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  return Array.from({ length: 8 }, () =>
    chars[Math.floor(Math.random() * chars.length)]
  ).join("").slice(0,8);
}

function rollDice(dice, held) {
  return dice.map((d, i) =>
    held[i] ? d : Math.floor(Math.random() * 6) + 1
  );
}

function countDice(dice) {
  const c = {};
  dice.forEach(d => c[d] = (c[d] || 0) + 1);
  return c;
}

function scoreCategory(dice, cat) {
  const c = countDice(dice);
  const vals = Object.entries(c).map(([k,v]) => [Number(k), v]);

  switch (cat) {
    case "ones": return dice.filter(d => d === 1).length;
    case "twos": return dice.filter(d => d === 2).length * 2;
    case "threes": return dice.filter(d => d === 3).length * 3;
    case "fours": return dice.filter(d => d === 4).length * 4;
    case "fives": return dice.filter(d => d === 5).length * 5;
    case "sixes": return dice.filter(d => d === 6).length * 6;
    case "pair":
      return Math.max(...vals.filter(v => v[1] >= 2).map(v => v[0]*2), 0);
    case "twoPairs":
      const pairs = vals.filter(v => v[1] >= 2).map(v => v[0]).sort((a,b)=>b-a);
      return pairs.length >= 2 ? pairs[0]*2 + pairs[1]*2 : 0;
    case "threeKind":
      return Math.max(...vals.filter(v => v[1] >= 3).map(v => v[0]*3), 0);
    case "fourKind":
      return Math.max(...vals.filter(v => v[1] >= 4).map(v => v[0]*4), 0);
    case "smallStraight":
      return [1,2,3,4,5].every(n => dice.includes(n)) ? 15 : 0;
    case "largeStraight":
      return [2,3,4,5,6].every(n => dice.includes(n)) ? 20 : 0;
    case "fullHouse":
      const three = vals.find(v => v[1] === 3);
      const two = vals.find(v => v[1] === 2);
      return three && two ? three[0]*3 + two[0]*2 : 0;
    case "chance":
      return dice.reduce((a,b)=>a+b,0);
    case "yatzy":
      return vals.some(v => v[1] === 5) ? 50 : 0;
  }
}

io.on("connection", socket => {

  socket.on("hostGame", ({ name, mode }, cb) => {
    let code;
    do { code = generateCode(); } while (games[code]);

    // determine dice count based on mode
    const diceCount = mode === "crazy" ? 10 : mode === "insane" ? 20 : 5;

    games[code] = {
      players: [{
        id: socket.id,
        name,
        scores: {},
        total: 0,
        bonus: false,
        isHost: true
      }],
      current: 0,
      dice: Array(diceCount).fill(1),
      held: Array(diceCount).fill(false),
      rolls: 0,
      finished: false,
      started: false,
      mode
    };

    socket.join(code);
    cb({ success: true, code, game: games[code] });
  });

  socket.on("joinGame", ({ name, code }, cb) => {
    const g = games[code];
    if (!g || g.players.length >= MAX_PLAYERS) {
      cb({ success: false, error: "Game not found or full" });
      return;
    }
    if (g.started) {
      cb({ success: false, error: "Game already started" });
      return;
    }
    if (g.players.some(p => p.name === name)) {
      cb({ success: false, error: "Name already taken" });
      return;
    }

    g.players.push({
      id: socket.id,
      name,
      scores: {},
      total: 0,
      bonus: false,
      isHost: false
    });

    socket.join(code);
    io.to(code).emit("update", g);
    cb({ success: true, game: g });
  });

  socket.on("rejoinGame", ({ name, code }, cb) => {
    const g = games[code];
    if (!g) { cb({ success: false }); return; }
    const player = g.players.find(p => p.name === name);
    if (!player) { cb({ success: false }); return; }
    player.id = socket.id;
    socket.join(code);
    cb({ success: true, game: g });
    io.to(code).emit("update", g);
  });

  socket.on("leaveGame", code => {
    const g = games[code];
    if (!g) return;
    const idx = g.players.findIndex(p => p.id === socket.id);
    if (idx !== -1) g.players.splice(idx, 1);
    socket.leave(code);

    if(g.players.length > 0 && !g.players.some(p=>p.isHost)){
      g.players[0].isHost = true;
    }

    if(g.players.length === 0){
      delete games[code];
      return;
    }

    io.to(code).emit("update", g);
  });

  socket.on("startGame", code => {
    const g = games[code];
    if (!g) return;
    const host = g.players.find(p => p.id === socket.id && p.isHost);
    if (!host) return;

    g.started = true;
    io.to(code).emit("update", g);
  });

  socket.on("roll", code => {
    const g = games[code];
    if (!g || g.finished || !g.started) return;
    const p = g.players[g.current];
    if (p.id !== socket.id || g.rolls >= 3) return;
    g.dice = rollDice(g.dice, g.held);
    g.rolls++;
    io.to(code).emit("update", g);
  });

  socket.on("hold", ({ code, i }) => {
    const g = games[code];
    if (!g || g.rolls === 0) return;
    g.held[i] = !g.held[i];
    io.to(code).emit("update", g);
  });

  socket.on("score", ({ code, cat }) => {
    const g = games[code];
    if (!g || g.finished || g.rolls === 0) return;
    const p = g.players[g.current];
    if (p.id !== socket.id || p.scores[cat] !== undefined) return;

    p.scores[cat] = scoreCategory(g.dice, cat);
    p.total = Object.values(p.scores).reduce((a,b)=>a+b,0);

    g.current = (g.current + 1) % g.players.length;
    g.rolls = 0;
    g.held = Array(g.dice.length).fill(false);

    if (g.players.every(pl =>
      CATEGORIES.every(c => pl.scores[c] !== undefined)
    )) g.finished = true;

    io.to(code).emit("update", g);
  });

  socket.on("newGame", code => {
    const g = games[code];
    if (!g) return;
    const host = g.players.find(p => p.id === socket.id && p.isHost);
    if (!host) return;

    const newCode = generateCode();
    const diceCount = g.mode === "crazy" ? 10 : g.mode === "insane" ? 20 : 5;

    const newGame = {
      players: g.players.map(p => ({
        id: p.id,
        name: p.name,
        scores: {},
        total: 0,
        bonus: false,
        isHost: p.isHost
      })),
      current: 0,
      dice: Array(diceCount).fill(1),
      held: Array(diceCount).fill(false),
      rolls: 0,
      finished: false,
      started: false,
      mode: g.mode
    };

    games[newCode] = newGame;

    g.players.forEach(p => {
      io.to(p.id).emit("promptNewGame", { newCode });
    });

    delete games[code];
  });

});
server.listen(3000, () => console.log("Server running at http://localhost:3000"));
