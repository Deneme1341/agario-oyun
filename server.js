const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const MAP_SIZE = 4000; // Büyük 6x6 (A1 - F6) Harita
const FOOD_COUNT = 450;
const VIRUS_COUNT = 25;
const VIRUS_RADIUS = 55;
const MAX_CELLS = 16;

const rooms = {
  'Oda 1 (FFA - Serbest)': { players: {}, foods: [], viruses: [], ejected: [] },
  'Oda 2 (Hızlı Arena)': { players: {}, foods: [], viruses: [], ejected: [] },
  'Oda 3 (Pro Meydanı)': { players: {}, foods: [], viruses: [], ejected: [] }
};

function randomColor() {
  const colors = ['#ff4757', '#2ed573', '#1e90ff', '#ffa502', '#eccc68', '#ff6b81', '#7bed9f', '#70a1ff', '#a55eea', '#ff7f50'];
  return colors[Math.floor(Math.random() * colors.length)];
}

function spawnFood() {
  return {
    id: Math.random().toString(36).substr(2, 9),
    x: Math.random() * MAP_SIZE,
    y: Math.random() * MAP_SIZE,
    color: randomColor()
  };
}

function spawnVirus() {
  return {
    id: Math.random().toString(36).substr(2, 9),
    x: 150 + Math.random() * (MAP_SIZE - 300),
    y: 150 + Math.random() * (MAP_SIZE - 300),
    radius: VIRUS_RADIUS
  };
}

// Odaları doldur
for (let roomName in rooms) {
  for (let i = 0; i < FOOD_COUNT; i++) rooms[roomName].foods.push(spawnFood());
  for (let i = 0; i < VIRUS_COUNT; i++) rooms[roomName].viruses.push(spawnVirus());
}

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.emit('roomList', getRoomCounts());

  socket.on('joinRoom', ({ name, room }) => {
    if (!rooms[room]) return;
    currentRoom = room;
    socket.join(room);

    rooms[room].players[socket.id] = {
      id: socket.id,
      name: name || 'İsimsiz',
      color: randomColor(),
      targetX: 0,
      targetY: 0,
      cells: [
        {
          id: Math.random().toString(36).substr(2, 9),
          x: 200 + Math.random() * (MAP_SIZE - 400),
          y: 200 + Math.random() * (MAP_SIZE - 400),
          radius: 32,
          vx: 0,
          vy: 0,
          mergeTime: 0
        }
      ]
    };

    io.emit('roomList', getRoomCounts());
  });

  socket.on('mouseMove', (target) => {
    if (currentRoom && rooms[currentRoom]?.players[socket.id]) {
      rooms[currentRoom].players[socket.id].targetX = target.x;
      rooms[currentRoom].players[socket.id].targetY = target.y;
    }
  });

  // SPACE TUŞU: BÖLÜNME
  socket.on('split', () => {
    if (!currentRoom || !rooms[currentRoom]?.players[socket.id]) return;
    const p = rooms[currentRoom].players[socket.id];
    const newCells = [];
    const angle = Math.atan2(p.targetY, p.targetX);

    p.cells.forEach(cell => {
      if (cell.radius >= 42 && (p.cells.length + newCells.length) < MAX_CELLS) {
        // Kütleyi ikiye böl (Alan korunumu: r / sqrt(2))
        const newRadius = cell.radius / Math.SQRT2;
        cell.radius = newRadius;
        cell.mergeTime = Date.now() + 12000; // 12 saniye sonra tekrar birleşebilir

        newCells.push({
          id: Math.random().toString(36).substr(2, 9),
          x: cell.x + Math.cos(angle) * (newRadius * 1.5),
          y: cell.y + Math.sin(angle) * (newRadius * 1.5),
          radius: newRadius,
          vx: Math.cos(angle) * 24,
          vy: Math.sin(angle) * 24,
          mergeTime: Date.now() + 12000
        });
      }
    });

    p.cells.push(...newCells);
  });

  // E veya W TUŞU: YEM ATMA / BESLEME
  socket.on('eject', () => {
    if (!currentRoom || !rooms[currentRoom]?.players[socket.id]) return;
    const room = rooms[currentRoom];
    const p = room.players[socket.id];
    const angle = Math.atan2(p.targetY, p.targetX);

    p.cells.forEach(cell => {
      if (cell.radius >= 38) {
        cell.radius -= 2.2;
        room.ejected.push({
          id: Math.random().toString(36).substr(2, 9),
          x: cell.x + Math.cos(angle) * (cell.radius + 10),
          y: cell.y + Math.sin(angle) * (cell.radius + 10),
          vx: Math.cos(angle) * 22,
          vy: Math.sin(angle) * 22,
          color: p.color,
          radius: 11
        });
      }
    });
  });

  socket.on('disconnect', () => {
    if (currentRoom && rooms[currentRoom]) {
      delete rooms[currentRoom].players[socket.id];
      io.emit('roomList', getRoomCounts());
    }
  });
});

function getRoomCounts() {
  const counts = {};
  for (let r in rooms) counts[r] = Object.keys(rooms[r].players).length;
  return counts;
}

// Ana Oyun Fiziği Döngüsü (Saniyede 30 Kare)
setInterval(() => {
  const now = Date.now();

  for (let roomName in rooms) {
    const room = rooms[roomName];
    const players = room.players;

    // Atılan yemlerin (E/W) hareketi
    for (let i = room.ejected.length - 1; i >= 0; i--) {
      let ej = room.ejected[i];
      ej.x += ej.vx;
      ej.y += ej.vy;
      ej.vx *= 0.88;
      ej.vy *= 0.88;
      ej.x = Math.max(10, Math.min(MAP_SIZE - 10, ej.x));
      ej.y = Math.max(10, Math.min(MAP_SIZE - 10, ej.y));
    }

    for (let id in players) {
      let p = players[id];

      // Oyuncunun merkezini bul (çoklu hücrede fare yönü için)
      let centerX = 0, centerY = 0;
      p.cells.forEach(c => { centerX += c.x; centerY += c.y; });
      centerX /= p.cells.length;
      centerY /= p.cells.length;

      for (let i = 0; i < p.cells.length; i++) {
        let cell = p.cells[i];

        // Fareye doğru hareket
        let dx = (centerX + p.targetX) - cell.x;
        let dy = (centerY + p.targetY) - cell.y;
        let angle = Math.atan2(dy, dx);
        let speed = Math.max(1.8, 7.5 - (cell.radius / 35));

        cell.x += Math.cos(angle) * speed + cell.vx;
        cell.y += Math.sin(angle) * speed + cell.vy;
        cell.vx *= 0.85;
        cell.vy *= 0.85;

        // Harita sınırları
        cell.x = Math.max(cell.radius, Math.min(MAP_SIZE - cell.radius, cell.x));
        cell.y = Math.max(cell.radius, Math.min(MAP_SIZE - cell.radius, cell.y));

        // Kendi hücreleri arası çarpışma ve birleşme
        for (let j = i + 1; j < p.cells.length; j++) {
          let otherCell = p.cells[j];
          let dist = Math.hypot(cell.x - otherCell.x, cell.y - otherCell.y);
          let minDist = cell.radius + otherCell.radius;

          if (now > cell.mergeTime && now > otherCell.mergeTime) {
            // Birleşme zamanı geldiyse yut
            if (dist < Math.max(cell.radius, otherCell.radius) * 0.8) {
              cell.radius = Math.hypot(cell.radius, otherCell.radius);
              p.cells.splice(j, 1);
              j--;
              continue;
            }
          } else if (dist < minDist && dist > 0) {
            // Birleşme süresi dolmadıysa birbirini ittir
            let overlap = (minDist - dist) / 2;
            let pushAngle = Math.atan2(otherCell.y - cell.y, otherCell.x - cell.x);
            cell.x -= Math.cos(pushAngle) * overlap * 0.5;
            cell.y -= Math.sin(pushAngle) * overlap * 0.5;
            otherCell.x += Math.cos(pushAngle) * overlap * 0.5;
            otherCell.y += Math.sin(pushAngle) * overlap * 0.5;
          }
        }

        // 1. Normal Yem Yeme
        for (let fIdx = room.foods.length - 1; fIdx >= 0; fIdx--) {
          let f = room.foods[fIdx];
          if (Math.hypot(cell.x - f.x, cell.y - f.y) < cell.radius) {
            cell.radius += 0.45;
            room.foods[fIdx] = spawnFood();
          }
        }

        // 2. Atılan Yemleri (E/W) Yeme
        for (let eIdx = room.ejected.length - 1; eIdx >= 0; eIdx--) {
          let ej = room.ejected[eIdx];
          if (Math.hypot(cell.x - ej.x, cell.y - ej.y) < cell.radius) {
            cell.radius += 1.8;
            room.ejected.splice(eIdx, 1);
          }
        }

        // 3. YEŞİL DİKEN (VİRÜS) PATLATMA MANTIĞI
        for (let vIdx = room.viruses.length - 1; vIdx >= 0; vIdx--) {
          let v = room.viruses[vIdx];
          let dist = Math.hypot(cell.x - v.x, cell.y - v.y);

          // Oyuncu dikenden büyükse ve üzerine geldiyse PATLA!
          if (dist < cell.radius && cell.radius > v.radius * 1.1) {
            room.viruses[vIdx] = spawnVirus(); // Yeni diken doğsun
            cell.radius += 10; // Diken kütlesini al

            // Parçalara bölün (Maksimum hücre sınırına kadar)
            let pieces = Math.min(8, MAX_CELLS - p.cells.length);
            if (pieces > 0) {
              let subRadius = Math.max(24, cell.radius / Math.sqrt(pieces + 1));
              cell.radius = subRadius;
              cell.mergeTime = now + 15000;

              for (let k = 0; k < pieces; k++) {
                let burstAngle = (Math.PI * 2 / pieces) * k;
                p.cells.push({
                  id: Math.random().toString(36).substr(2, 9),
                  x: cell.x + Math.cos(burstAngle) * 20,
                  y: cell.y + Math.sin(burstAngle) * 20,
                  radius: subRadius,
                  vx: Math.cos(burstAngle) * 22,
                  vy: Math.sin(burstAngle) * 22,
                  mergeTime: now + 15000
                });
              }
            }
            break;
          }
        }
      }
    }

    // 4. Oyuncuların Birbirini Yemesi
    const playerIds = Object.keys(players);
    for (let i = 0; i < playerIds.length; i++) {
      let p1 = players[playerIds[i]];
      if (!p1) continue;

      for (let j = 0; j < playerIds.length; j++) {
        if (i === j) continue;
        let p2 = players[playerIds[j]];
        if (!p2) continue;

        for (let c1 of p1.cells) {
          for (let c2Idx = p2.cells.length - 1; c2Idx >= 0; c2Idx--) {
            let c2 = p2.cells[c2Idx];
            let dist = Math.hypot(c1.x - c2.x, c1.y - c2.y);

            if (dist < c1.radius - (c2.radius * 0.3) && c1.radius > c2.radius * 1.15) {
              c1.radius = Math.hypot(c1.radius, c2.radius);
              p2.cells.splice(c2Idx, 1);
            }
          }
        }

        // Eğer p2'nin hiç hücresi kalmadıysa elendi
        if (p2.cells.length === 0) {
          io.to(p2.id).emit('eaten');
          delete players[p2.id];
          io.emit('roomList', getRoomCounts());
        }
      }
    }

    io.to(roomName).emit('gameState', {
      players: room.players,
      foods: room.foods,
      viruses: room.viruses,
      ejected: room.ejected
    });
  }
}, 1000 / 30);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Oyun sunucusu aktif: http://localhost:${PORT}`);
});