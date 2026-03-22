const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname)));
app.use('/images', express.static(path.join(__dirname, 'public/images')));

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

const imagePools = {
    "classic": Array.from({length: 50}, (_, i) => `/images/classic/${i+1}.jpg`),
    "fun": Array.from({length: 50}, (_, i) => `/images/fun/${i+1}.jpg`)
};

const rooms = {}; 
const socketToUserId = {};

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
            targetPoints: 30, roundTimeLimit: 60, currentDrawerId: null, 
            gameState: "LOBBY", drawerQueue: [], fakeImages: {}, votes: {}, 
            currentImages: [], currentClue: "", correctImage: "", currentPool: [], gameTimer: null
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
            gameState: room.gameState, currentDrawerId: room.currentDrawerId
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
        if (timeLeft <= 0) { clearInterval(room.gameTimer); if (onTimeout) onTimeout(); }
    }, 1000);
}

io.on('connection', (socket) => {
    socket.on('joinGame', (data) => {
        const { userId, name, roomId, action } = data;
        if (action === 'join' && !rooms[roomId]) return socket.emit('errorMsg', 'Room not found!');
        socket.roomId = roomId; socket.userId = userId; socket.join(roomId);
        socketToUserId[socket.id] = userId;
        const room = getRoom(roomId);
        room.playerNames[userId] = name;
        if (room.scores[userId] === undefined) room.scores[userId] = 0;
        if (!room.players.includes(userId)) {
            room.players.push(userId);
            if (room.gameState !== "LOBBY") room.drawerQueue.push(userId);
        }
        if (!room.hostId) room.hostId = userId;
        socket.emit('joinSuccess');
        if (room.gameState !== "LOBBY") socket.emit('forceGameView');
        emitPlayerList(roomId);
    });

    socket.on('requestStart', (data) => {
        const room = rooms[socket.roomId];
        if (room && room.hostId === socket.userId && room.gameState === "LOBBY") {
            room.players.forEach(id => room.scores[id] = 0);
            room.targetPoints = parseInt(data.targetPoints);
            room.roundTimeLimit = parseInt(data.roundTime);
            room.currentPool = imagePools[data.mode] || imagePools["classic"];
            startNewRound(socket.roomId);
        }
    });

    function startNewRound(roomId) {
        const room = rooms[roomId]; if (!room) return;
        room.gameState = "DRAWING"; room.fakeImages = {}; room.votes = {}; room.currentClue = "";
        if (room.drawerQueue.length === 0) room.drawerQueue = shuffle([...room.players]);
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
        const room = rooms[socket.roomId]; if (!room || room.currentDrawerId !== socket.userId) return;
        room.gameState = "FAKING"; room.correctImage = data.image; room.currentClue = data.clue;
        room.players.forEach(pId => {
            const sid = Object.keys(socketToUserId).find(k => socketToUserId[k] === pId && io.sockets.sockets.get(k)?.roomId === socket.roomId);
            if (sid) {
                const pImgs = (pId !== room.currentDrawerId) ? shuffle(room.currentPool).filter(img => img !== room.correctImage).slice(0, 6) : [];
                io.to(sid).emit('showClue', { clue: room.currentClue, pImages: pImgs, drawerId: room.currentDrawerId });
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
        const room = rooms[roomId]; if (!room || room.gameState !== "FAKING") return;
        room.gameState = "VOTING";
        let opts = shuffle([...new Set([room.correctImage, ...Object.values(room.fakeImages)])]);
        while(opts.length < Math.min(6, room.currentPool.length)) {
            let rand = room.currentPool[Math.floor(Math.random()*room.currentPool.length)];
            if(!opts.includes(rand)) opts.push(rand);
        }
        io.to(roomId).emit('startVoting', { options: shuffle(opts), drawerId: room.currentDrawerId });
        startTimer(roomId, room.roundTimeLimit, () => finalizeRound(roomId));
    }

    socket.on('submitVote', (img) => {
        const room = rooms[socket.roomId];
        if (room && socket.userId !== room.currentDrawerId) {
            room.votes[socket.userId] = img;
            if (Object.keys(room.votes).length >= (room.players.length - 1)) finalizeRound(socket.roomId);
        }
    });

    function finalizeRound(roomId) {
        const room = rooms[roomId]; if (!room || room.gameState !== "VOTING") return;
        clearInterval(room.gameTimer); room.gameState = "RESULTS";
        let totalGuessers = room.players.length - 1, correct = 0;
        for (let vId in room.votes) if (room.votes[vId] === room.correctImage) correct++;
        
        // 1. نقاط الملمح (2x لكل لاعب حزر، بشرط ليس الجميع وليس صفر)
        if (correct > 0 && correct < totalGuessers) {
            room.scores[room.currentDrawerId] += (correct * 2);
        }

        // 2. نقاط المخمن (2 نقطة فقط للتخمين الصحيح)
        for (let vId in room.votes) {
            if (room.votes[vId] === room.correctImage) room.scores[vId] += 2;
        }

        // 3. نقاط المضلل (1 نقطة لكل لاعب خدعه)
        for (let vId in room.votes) {
            const votedImg = room.votes[vId];
            if (votedImg !== room.correctImage) {
                for (let fId in room.fakeImages) {
                    if (votedImg === room.fakeImages[fId] && fId !== vId) room.scores[fId] += 1;
                }
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
                room.gameState = "LOBBY"; room.players.forEach(id => room.scores[id] = 0); emitPlayerList(roomId);
            } else if(room.players.length > 0) { startNewRound(roomId); }
        }, 8000);
    }

    socket.on('sendChat', (msg) => {
        const room = rooms[socket.roomId];
        if(room) io.to(socket.roomId).emit('newChat', { sender: room.playerNames[socket.userId], text: msg });
    });

    socket.on('disconnect', () => {
        const uId = socketToUserId[socket.id]; const rId = socket.roomId;
        delete socketToUserId[socket.id];
        const room = rooms[rId];
        if (room) {
            setTimeout(() => {
                if (!Object.values(socketToUserId).includes(uId)) {
                    room.players = room.players.filter(id => id !== uId);
                    if (uId === room.hostId) room.hostId = room.players[0] || null;
                    if (uId === room.currentDrawerId && room.gameState !== "LOBBY") startNewRound(rId);
                    emitPlayerList(rId);
                    if (room.players.length === 0) delete rooms[rId];
                }
            }, 5000);
        }
    });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
