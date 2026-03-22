const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;

// إعداد المسارات
app.use(express.static(path.join(__dirname)));
app.use('/images', express.static(path.join(__dirname, 'public/images')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// خزان الصور
const imagePools = {
    "classic": Array.from({length: 50}, (_, i) => `/images/classic/${i+1}.jpg`),
    "fun": Array.from({length: 50}, (_, i) => `/images/fun/${i+1}.jpg`)
};

const rooms = {}; 
const socketToUserId = {};

// وظيفة خلط المصفوفات (Fisher-Yates) لضمان العشوائية
function shuffle(array) {
    let a = [...array];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

function getRoom(roomId) {
    if (!rooms[roomId]) {
        rooms[roomId] = {
            players: [], scores: {}, playerNames: {}, hostId: null,
            playerReady: {}, targetPoints: 30, roundTimeLimit: 60,
            currentDrawerId: null, gameState: "LOBBY", drawerQueue: [],
            fakeImages: {}, votes: {}, currentImages: [], currentClue: "",
            correctImage: "", currentPool: [], gameTimer: null
        };
    }
    return rooms[roomId];
}

function emitPlayerList(roomId) {
    const room = rooms[roomId];
    if (room) {
        io.to(roomId).emit('updatePlayerList', { 
            players: room.players, playerNames: room.playerNames, 
            hostId: room.hostId, scores: room.scores, 
            gameState: room.gameState, currentDrawerId: room.currentDrawerId, 
            playerReady: room.playerReady 
        });
    }
}

function startTimer(roomId, duration, onTimeout) {
    const room = rooms[roomId];
    if (room.gameTimer) clearInterval(room.gameTimer);
    let timeLeft = duration;
    io.to(roomId).emit('timerUpdate', timeLeft);
    room.gameTimer = setInterval(() => {
        timeLeft--;
        io.to(roomId).emit('timerUpdate', timeLeft);
        if (timeLeft <= 0) { 
            clearInterval(room.gameTimer); 
            if (onTimeout) onTimeout(); 
        }
    }, 1000);
}

io.on('connection', (socket) => {
    socket.on('joinGame', (data) => {
        const { userId, name, roomId, action } = data;
        
        // منع الانضمام إذا كانت الغرفة غير موجودة والاختيار هو "انضمام"
        if (action === 'join' && !rooms[roomId]) {
            return socket.emit('errorMsg', 'Room not found! Check the ID.');
        }

        socket.roomId = roomId;
        socket.userId = userId;
        socket.join(roomId);
        socketToUserId[socket.id] = userId;

        const room = getRoom(roomId);
        room.playerNames[userId] = name;
        if (room.scores[userId] === undefined) room.scores[userId] = 0;
        
        if (!room.players.includes(userId)) {
            room.players.push(userId);
            // إضافة اللاعب للطابور فوراً إذا كانت المباراة جارية
            if (room.gameState !== "LOBBY" && !room.drawerQueue.includes(userId)) {
                room.drawerQueue.push(userId);
            }
        }
        
        if (!room.hostId) room.hostId = userId;

        socket.emit('joinSuccess'); // إخبار الواجهة بنجاح الدخول

        // المزامنة الفورية (Hot-Join)
        if (room.gameState !== "LOBBY") {
            socket.emit('forceGameView'); 
            if (room.gameState === "DRAWING") {
                const imgs = (userId === room.currentDrawerId) ? room.currentImages : [];
                socket.emit('roundStarted', { images: imgs, drawerId: room.currentDrawerId, drawerName: room.playerNames[room.currentDrawerId] });
            } else if (room.gameState === "FAKING") {
                const pImages = shuffle(room.currentPool).filter(img => img !== room.correctImage).slice(0, 6);
                socket.emit('showClue', { clue: room.currentClue, pImages: (userId === room.currentDrawerId ? [] : pImages), drawerId: room.currentDrawerId });
            } else if (room.gameState === "VOTING") {
                sendVotingOptions(roomId, socket.id);
            }
        }
        emitPlayerList(roomId);
    });

    socket.on('requestStart', (data) => {
        const room = rooms[socket.roomId];
        if (room && room.hostId === socket.userId && room.gameState === "LOBBY") {
            // تصفير النقاط عند كل بداية مباراة جديدة
            room.players.forEach(id => room.scores[id] = 0);
            
            room.targetPoints = parseInt(data.targetPoints);
            room.roundTimeLimit = parseInt(data.roundTime);
            room.currentPool = imagePools[data.mode] || imagePools["classic"];
            startNewRound(socket.roomId);
        }
    });

    function startNewRound(roomId) {
        const room = rooms[roomId];
        if (!room) return;
        room.gameState = "DRAWING"; room.fakeImages = {}; room.votes = {}; room.currentClue = "";
        
        const lastDrawer = room.currentDrawerId;

        // منطق الطابور ومنع التكرار المتتالي
        if (room.drawerQueue.length === 0) {
            let pool = shuffle([...room.players]);
            if (pool.length > 1 && pool[0] === lastDrawer) {
                const first = pool.shift();
                pool.push(first);
            }
            room.drawerQueue = pool;
        }

        room.currentDrawerId = room.drawerQueue.shift();
        room.currentImages = shuffle(room.currentPool).slice(0, 6);

        room.players.forEach(pId => {
            const sid = Object.keys(socketToUserId).find(k => socketToUserId[k] === pId && io.sockets.sockets.get(k)?.roomId === roomId);
            if (sid) {
                const imgs = (pId === room.currentDrawerId) ? room.currentImages : [];
                io.to(sid).emit('roundStarted', { images: imgs, drawerId: room.currentDrawerId, drawerName: room.playerNames[room.currentDrawerId] });
            }
        });
        startTimer(roomId, room.roundTimeLimit, () => { if(room.gameState === "DRAWING") startNewRound(roomId); });
    }

    socket.on('submitClue', (data) => {
        const room = rooms[socket.roomId];
        if (!room || room.currentDrawerId !== socket.userId) return;
        room.gameState = "FAKING"; room.correctImage = data.image; room.currentClue = data.clue;

        room.players.forEach(pId => {
            const sid = Object.keys(socketToUserId).find(k => socketToUserId[k] === pId && io.sockets.sockets.get(k)?.roomId === socket.roomId);
            if (sid) {
                if (pId !== room.currentDrawerId) {
                    const pImages = shuffle(room.currentPool).filter(img => img !== room.correctImage).slice(0, 6);
                    io.to(sid).emit('showClue', { clue: room.currentClue, pImages, drawerId: room.currentDrawerId });
                } else io.to(sid).emit('showClue', { clue: room.currentClue, pImages: [], drawerId: room.currentDrawerId });
            }
        });
        startTimer(socket.roomId, room.roundTimeLimit, () => proceedToVoting(socket.roomId));
    });

    socket.on('submitFake', (img) => {
        const room = rooms[socket.roomId];
        if (room && socket.userId !== room.currentDrawerId) {
            room.fakeImages[socket.userId] = img;
            if (Object.keys(room.fakeImages).length >= (room.players.length - 1)) proceedToVoting(socket.roomId);
        }
    });

    function proceedToVoting(roomId) {
        const room = rooms[roomId];
        if (!room) return;
        room.gameState = "VOTING";
        sendVotingOptions(roomId);
        startTimer(roomId, room.roundTimeLimit, () => finalizeRound(roomId));
    }

    function sendVotingOptions(roomId, targetSid = null) {
        const room = rooms[roomId];
        if (!room) return;
        let opts = shuffle([...new Set([room.correctImage, ...Object.values(room.fakeImages)])]);
        while(opts.length < Math.min(6, room.currentPool.length)) {
            let rand = room.currentPool[Math.floor(Math.random()*room.currentPool.length)];
            if(!opts.includes(rand)) opts.push(rand);
        }
        const data = { options: shuffle(opts), drawerId: room.currentDrawerId };
        if(targetSid) io.to(targetSid).emit('startVoting', data);
        else io.to(roomId).emit('startVoting', data);
    }

    socket.on('submitVote', (img) => {
        const room = rooms[socket.roomId];
        if (room && socket.userId !== room.currentDrawerId) {
            room.votes[socket.userId] = img;
            if (Object.keys(room.votes).length >= (room.players.length - 1)) finalizeRound(socket.roomId);
        }
    });

    function finalizeRound(roomId) {
        const room = rooms[roomId];
        if (!room) return;
        if (room.gameTimer) clearInterval(room.gameTimer);
        room.gameState = "RESULTS";
        let total = room.players.length - 1, correct = 0;
        for (let vId in room.votes) if (room.votes[vId] === room.correctImage) correct++;
        
        if (correct > 0 && correct < total) {
            room.scores[room.currentDrawerId] += (correct * 2);
            for (let vId in room.votes) if (room.votes[vId] === room.correctImage) room.scores[vId] += 2;
        } else if (correct === total) {
            for (let vId in room.votes) room.scores[vId] += 2;
        }

        for (let vId in room.votes) {
            for (let fId in room.fakeImages) {
                if (room.votes[vId] === room.fakeImages[fId] && fId !== vId) room.scores[fId] += 1;
            }
        }

        let vD = {}, fk = {};
        for (let vId in room.votes) { 
            if (!vD[room.votes[vId]]) vD[room.votes[vId]] = []; 
            vD[room.votes[vId]].push(room.playerNames[vId]); 
        }
        for (let fId in room.fakeImages) fk[room.fakeImages[fId]] = room.playerNames[fId];

        io.to(roomId).emit('roundFinished', { correctImage: room.correctImage, scores: room.scores, voteDetails: vD, fakers: fk });
        emitPlayerList(roomId);

        setTimeout(() => {
            if (room.players.some(id => room.scores[id] >= room.targetPoints)) {
                const lb = room.players.map(id => ({ name: room.playerNames[id], score: room.scores[id] })).sort((a,b) => b.score - a.score);
                io.to(roomId).emit('gameOver', { leaderboard: lb });
                room.gameState = "LOBBY";
                // تصفير النقاط فور نهاية المباراة
                room.players.forEach(id => room.scores[id] = 0);
                emitPlayerList(roomId);
            } else if(room.players.length > 0) {
                startNewRound(roomId);
            }
        }, 8000);
    }

    socket.on('sendChat', (msg) => {
        const room = rooms[socket.roomId];
        if(room) io.to(socket.roomId).emit('newChat', { sender: room.playerNames[socket.userId], text: msg });
    });

    socket.on('forceEndGame', () => {
        const room = rooms[socket.roomId];
        if (room && room.hostId === socket.userId) {
            if (room.gameTimer) clearInterval(room.gameTimer);
            room.gameState = "LOBBY";
            room.players.forEach(id => { room.scores[id] = 0; room.playerReady[id] = false; });
            io.to(socket.roomId).emit('gameResetByHost');
            emitPlayerList(socket.roomId);
        }
    });

    socket.on('disconnect', () => {
        const sid = socket.id;
        const uId = socket.userId;
        const rId = socket.roomId;
        delete socketToUserId[sid];
        
        const room = rooms[rId];
        if (room) {
            setTimeout(() => {
                if (!Object.values(socketToUserId).includes(uId)) {
                    room.players = room.players.filter(id => id !== uId);
                    room.drawerQueue = room.drawerQueue.filter(id => id !== uId);
                    if (uId === room.hostId) room.hostId = room.players.length > 0 ? room.players[0] : null;
                    if (uId === room.currentDrawerId && room.gameState !== "LOBBY") startNewRound(rId);
                    emitPlayerList(rId);
                    if (room.players.length === 0) delete rooms[rId];
                }
            }, 5000);
        }
    });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
