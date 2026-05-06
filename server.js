const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ── SAVES ──────────────────────────────────────
const SAVES_DIR = path.join(__dirname, 'saves');
if (!fs.existsSync(SAVES_DIR)) fs.mkdirSync(SAVES_DIR, { recursive: true });

function savePath(code) { return path.join(SAVES_DIR, `${code}.json`); }

function saveRoom(room) {
  try {
    const data = {
      code: room.code,
      players: Array.from(room.players.values()),
      messages: room.messages.slice(-100),
      combat: room.combat,
      savedAt: Date.now()
    };
    fs.writeFileSync(savePath(room.code), JSON.stringify(data));
    return true;
  } catch(e) { console.error('Error guardando:', e); return false; }
}

function loadRoom(code) {
  try {
    const file = savePath(code.toUpperCase());
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch(e) { return null; }
}

// ── ROOMS ──────────────────────────────────────
const rooms = new Map();

function getRoom(code) {
  if (!rooms.has(code)) {
    rooms.set(code, { code, players: new Map(), messages: [], combat: { active: false, combatants: [] }, createdAt: Date.now() });
  }
  return rooms.get(code);
}

function roomPublic(room) {
  return {
    code: room.code,
    players: Array.from(room.players.values()).map(p => ({ id: p.id, name: p.name, character: p.character, color: p.color, online: p.online })),
    messages: room.messages.slice(-100),
    combat: room.combat,
    savedAt: room.savedAt || null
  };
}

function generateCode() { return Math.random().toString(36).substr(2, 6).toUpperCase(); }
const COLORS = ['#c9a84c','#4caf50','#5090e0','#e05050','#9c27b0','#ff9800'];
function getPlayerColor(idx) { return COLORS[idx % COLORS.length]; }

// Auto-save every 2 minutes
setInterval(() => {
  rooms.forEach(room => { if (room.messages.length > 0) { room.savedAt = Date.now(); saveRoom(room); } });
}, 2 * 60 * 1000);

// ── SOCKET.IO ──────────────────────────────────
io.on('connection', (socket) => {
  let currentRoom = null;
  let currentPlayer = null;

  socket.on('join_room', ({ code, playerName, loadSave }) => {
    const roomCode = code ? code.toUpperCase() : generateCode();
    const room = getRoom(roomCode);

    // Load saved messages if room is empty
    if (room.messages.length === 0) {
      const saved = loadRoom(roomCode);
      if (saved) {
        room.messages = saved.messages || [];
        room.combat = saved.combat || { active: false, combatants: [] };
        room.savedAt = saved.savedAt;
        // Restore characters
        if (saved.players) {
          saved.players.forEach(sp => {
            if (sp.name === playerName && sp.character) {
              // Will be used below
            }
          });
        }
        console.log(`📂 Sala ${roomCode} restaurada desde guardado.`);
      }
    }

    // Try to restore character from save
    let restoredChar = null;
    const savedRoom = loadRoom(roomCode);
    if (savedRoom?.players) {
      const sp = savedRoom.players.find(p => p.name === playerName);
      if (sp?.character) restoredChar = sp.character;
    }

    const existingPlayer = Array.from(room.players.values()).find(p => p.name === playerName);
    const player = {
      id: socket.id,
      name: playerName || 'Aventurero',
      character: restoredChar || existingPlayer?.character || null,
      color: existingPlayer?.color || getPlayerColor(room.players.size),
      online: true,
      joinedAt: Date.now()
    };

    room.players.set(socket.id, player);
    socket.join(roomCode);
    currentRoom = roomCode;
    currentPlayer = player;

    socket.emit('room_joined', { roomCode, room: roomPublic(room), playerId: socket.id, restoredChar });
    socket.to(roomCode).emit('player_joined', { player, room: roomPublic(room) });

    const isReturn = !!restoredChar;
    const sysMsg = { type: 'system', text: isReturn ? `⚔️ ${player.name} ha regresado a la aventura.` : `⚔️ ${player.name} se ha unido a la aventura.`, ts: Date.now() };
    room.messages.push(sysMsg);
    io.to(roomCode).emit('new_message', sysMsg);
  });

  // MANUAL SAVE
  socket.on('save_game', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    room.savedAt = Date.now();
    const ok = saveRoom(room);
    const time = new Date(room.savedAt).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
    const msg = { type: 'system', text: ok ? `💾 Partida guardada a las ${time}` : '❌ Error al guardar', ts: Date.now() };
    room.messages.push(msg);
    io.to(currentRoom).emit('new_message', msg);
    io.to(currentRoom).emit('game_saved', { savedAt: room.savedAt, ok });
  });

  socket.on('update_character', ({ character }) => {
    if (!currentRoom) return;
    const room = getRoom(currentRoom);
    const player = room.players.get(socket.id);
    if (player) { player.character = character; io.to(currentRoom).emit('player_updated', { playerId: socket.id, character, room: roomPublic(room) }); }
  });

  socket.on('send_message', ({ text, type }) => {
    if (!currentRoom || !currentPlayer) return;
    const room = getRoom(currentRoom);
    const msg = { type: type || 'player', playerId: socket.id, playerName: currentPlayer.name, playerColor: currentPlayer.color, character: currentPlayer.character, text, ts: Date.now() };
    room.messages.push(msg);
    if (room.messages.length > 200) room.messages = room.messages.slice(-200);
    io.to(currentRoom).emit('new_message', msg);
  });

  socket.on('dm_message', ({ text, options }) => {
    if (!currentRoom) return;
    const room = getRoom(currentRoom);
    const msg = { type: 'dm', text, options: options || [], ts: Date.now() };
    room.messages.push(msg);
    io.to(currentRoom).emit('new_message', msg);
    if (options && options.length) io.to(currentRoom).emit('show_options', options);
  });

  socket.on('roll_dice', ({ sides, qty, label }) => {
    if (!currentRoom || !currentPlayer) return;
    const results = Array(qty || 1).fill(0).map(() => Math.floor(Math.random() * sides) + 1);
    const total = results.reduce((a, b) => a + b, 0);
    const roll = { type: 'roll', playerId: socket.id, playerName: currentPlayer.name, playerColor: currentPlayer.color, sides, qty: qty || 1, results, total, label, isCrit: qty === 1 && results[0] === sides && sides === 20, isFail: qty === 1 && results[0] === 1 && sides === 20, ts: Date.now() };
    const room = getRoom(currentRoom);
    room.messages.push(roll);
    io.to(currentRoom).emit('dice_rolled', roll);
  });

  socket.on('start_combat', ({ enemies }) => {
    if (!currentRoom) return;
    const room = getRoom(currentRoom);
    room.combat = { active: true, turn: 0, combatants: [...Array.from(room.players.values()).map(p => ({ id: p.id, name: p.character?.name || p.name, hp: p.character?.hp || 100, maxHp: p.character?.hpMax || 100, init: Math.floor(Math.random() * 20) + 1, isPlayer: true })), ...(enemies || []).map(e => ({ ...e, isPlayer: false, init: Math.floor(Math.random() * 20) + 1 }))].sort((a, b) => b.init - a.init) };
    io.to(currentRoom).emit('combat_updated', room.combat);
    const msg = { type: 'system', text: '⚔️ ¡COMBATE INICIADO!', ts: Date.now() };
    room.messages.push(msg);
    io.to(currentRoom).emit('new_message', msg);
  });

  socket.on('end_combat', () => {
    if (!currentRoom) return;
    const room = getRoom(currentRoom);
    room.combat = { active: false, combatants: [] };
    io.to(currentRoom).emit('combat_updated', room.combat);
    const msg = { type: 'system', text: '🕊️ El combate ha concluido.', ts: Date.now() };
    room.messages.push(msg);
    io.to(currentRoom).emit('new_message', msg);
  });

  socket.on('next_turn', () => {
    if (!currentRoom) return;
    const room = getRoom(currentRoom);
    if (room.combat.active) { room.combat.turn = (room.combat.turn + 1) % room.combat.combatants.length; io.to(currentRoom).emit('combat_updated', room.combat); }
  });

  socket.on('disconnect', () => {
    if (!currentRoom || !currentPlayer) return;
    const room = rooms.get(currentRoom);
    if (room) {
      const player = room.players.get(socket.id);
      if (player) {
        player.online = false;
        room.savedAt = Date.now();
        saveRoom(room); // Auto-save on disconnect
        const msg = { type: 'system', text: `💨 ${player.name} se desconectó. 💾 Guardado automático.`, ts: Date.now() };
        room.messages.push(msg);
        io.to(currentRoom).emit('new_message', msg);
        io.to(currentRoom).emit('player_updated', { playerId: socket.id, online: false, room: roomPublic(room) });
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🐉 D&D Server en puerto ${PORT}`));
