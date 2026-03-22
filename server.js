const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;

// إعداد المجلد العام لملفات HTML و CSS
app.use(express.static(path.join(__dirname, 'index.html')));
// إعداد مسار الصور
app.use('/images', express.static(path.join(__dirname, 'public/images')));

app.get('/', (req, res) => { 
    res.sendFile(path.join(__dirname, 'index.html')); 
});

const imagePools = { 
    "classic": Array.from({length: 50}, (_, i) => `/images/classic/${i+1}.jpg`), 
    "fun": Array.from({length: 50}, (_, i) => `/images/fun/${i+1}.jpg`) 
};

const rooms = {}; 
const socketToUserId = {};

function shuffle(a) { 
    let b = [...a]; 
    for (let i = b.length - 1; i > 0; i--) { 
        const j = Math.floor(Math.random() * (i + 1)); 
        [b[i], b[j]] = [b[j], b[i]]; 
    } 
    return b; 
}

function getRoom(rid) { 
    if (!rooms[rid]) rooms[rid] = { 
        players: [], scores: {}, playerNames: {}, hostId: null, 
        targetPoints: 30, roundTimeLimit: 60, currentDrawerId: null, 
        gameState: "LOBBY", drawerQueue: [], fakeImages: {}, votes: {}, 
        currentImages: [], currentClue: "", correctImage: "", currentPool: [], gameTimer: null 
    }; 
    return rooms[rid]; 
}

function emitList(rid) { 
    const r = rooms[rid]; 
    if (r) io.to(rid).emit('updatePlayerList', { 
        players: r.players, playerNames: r.playerNames, hostId: r.hostId, 
        scores: r.scores, gameState: r.gameState, currentDrawerId: r.currentDrawerId 
    }); 
}

function startTimer(rid, dur, cb) { 
    const r = rooms[rid]; 
    if (r.gameTimer) clearInterval(r.gameTimer); 
    let tl = dur; 
    io.to(rid).emit('timerUpdate', tl); 
    r.gameTimer = setInterval(() => { 
        tl--; 
        io.to(rid).emit('timerUpdate', tl); 
        if (tl <= 0) { clearInterval(r.gameTimer); if (cb) cb(); } 
    }, 1000); 
}

io.on('connection', (socket) => {
    socket.on('joinGame', (d) => {
        const { userId, name, roomId } = d;
        const r = getRoom(roomId); 
        
        socket.roomId = roomId; socket.userId = userId; socket.join(roomId); 
        socketToUserId[socket.id] = userId;
        
        r.playerNames[userId] = name; 
        if (r.scores[userId] === undefined) r.scores[userId] = 0;
        if (!r.players.includes(userId)) r.players.push(userId);
        if (!r.hostId) r.hostId = userId;

        socket.emit('joinSuccess');
        emitList(roomId);
    });

    socket.on('requestStart', (d) => {
        const r = rooms[socket.roomId];
        if (r && r.hostId === socket.userId) {
            r.targetPoints = parseInt(d.targetPoints);
            r.roundTimeLimit = parseInt(d.roundTime);
            r.currentPool = imagePools[d.mode] || imagePools["classic"];
            startNewRound(socket.roomId);
        }
    });

    function startNewRound(rid) {
        const r = rooms[rid]; if (!r) return;
        r.gameState = "DRAWING"; r.fakeImages = {}; r.votes = {};
        if (r.drawerQueue.length === 0) r.drawerQueue = shuffle([...r.players]);
        r.currentDrawerId = r.drawerQueue.shift();
        r.currentImages = shuffle(r.currentPool).slice(0, 6);
        
        io.to(rid).emit('forceGameView');
        r.players.forEach(pId => {
            const sid = Object.keys(socketToUserId).find(k => socketToUserId[k] === pId);
            if (sid) {
                const imgs = (pId === r.currentDrawerId) ? r.currentImages : [];
                io.to(sid).emit('roundStarted', { images: imgs, drawerId: r.currentDrawerId, drawerName: r.playerNames[r.currentDrawerId] });
            }
        });
        startTimer(rid, r.roundTimeLimit, () => { if(r.gameState === "DRAWING") startNewRound(rid); });
    }

    socket.on('submitClue', (d) => {
        const r = rooms[socket.roomId]; if (!r || r.currentDrawerId !== socket.userId) return;
        r.gameState = "FAKING"; r.correctImage = d.image; r.currentClue = d.clue;
        r.players.forEach(pId => {
            const sid = Object.keys(socketToUserId).find(k => socketToUserId[k] === pId);
            if (sid) {
                const pImgs = (pId !== r.currentDrawerId) ? shuffle(r.currentPool).filter(i => i !== r.correctImage).slice(0, 6) : [];
                io.to(sid).emit('showClue', { clue: r.currentClue, pImages: pImgs, drawerId: r.currentDrawerId });
            }
        });
        startTimer(socket.roomId, r.roundTimeLimit, () => proceedToVote(socket.roomId));
    });

    socket.on('submitFake', (img) => {
        const r = rooms[socket.roomId];
        if (r && socket.userId !== r.currentDrawerId) {
            r.fakeImages[socket.userId] = img;
            if (Object.keys(r.fakeImages).length >= (r.players.length - 1)) proceedToVote(socket.roomId);
        }
    });

    function proceedToVote(rid) {
        const r = rooms[rid]; if (!r || r.gameState !== "FAKING") return;
        r.gameState = "VOTING";
        let opts = shuffle([...new Set([r.correctImage, ...Object.values(r.fakeImages)])]);
        io.to(rid).emit('startVoting', { options: opts, drawerId: r.currentDrawerId });
        startTimer(rid, r.roundTimeLimit, () => finalize(rid));
    }

    socket.on('submitVote', (img) => {
        const r = rooms[socket.roomId];
        if (r && socket.userId !== r.currentDrawerId) {
            r.votes[socket.userId] = img;
            if (Object.keys(r.votes).length >= (r.players.length - 1)) finalize(socket.roomId);
        }
    });

    function finalize(rid) {
        const r = rooms[rid]; if (!r || r.gameState !== "VOTING") return;
        clearInterval(r.gameTimer); r.gameState = "RESULTS";
        
        let correctCount = 0;
        for (let vId in r.votes) if (r.votes[vId] === r.correctImage) correctCount++;
        
        if (correctCount > 0 && correctCount < (r.players.length - 1)) r.scores[r.currentDrawerId] += 3;
        for (let vId in r.votes) {
            if (r.votes[vId] === r.correctImage) r.scores[vId] += 2;
            else {
                for (let fId in r.fakeImages) {
                    if (r.votes[vId] === r.fakeImages[fId]) r.scores[fId] += 1;
                }
            }
        }

        let vD = {}, fk = {};
        for (let vId in r.votes) { 
            if (!vD[r.votes[vId]]) vD[r.votes[vId]] = []; 
            vD[r.votes[vId]].push(r.playerNames[vId]); 
        }
        for (let fId in r.fakeImages) fk[r.fakeImages[fId]] = r.playerNames[fId];
        
        io.to(rid).emit('roundFinished', { correctImage: r.correctImage, scores: r.scores, voteDetails: vD, fakers: fk });
        emitList(rid);
        
        setTimeout(() => {
            if (r.players.some(id => r.scores[id] >= r.targetPoints)) {
                const lb = r.players.map(id => ({ name: r.playerNames[id], score: r.scores[id] })).sort((a,b) => b.score - a.score);
                io.to(rid).emit('gameOver', { leaderboard: lb });
                r.gameState = "LOBBY"; r.players.forEach(id => r.scores[id] = 0);
            } else { startNewRound(rid); }
        }, 8000);
    }

    socket.on('sendChat', (msg) => {
        const r = rooms[socket.roomId];
        if(r) io.to(socket.roomId).emit('newChat', { sender: r.playerNames[socket.userId], text: msg });
    });

    socket.on('disconnect', () => {
        const rid = socket.roomId;
        delete socketToUserId[socket.id];
        if (rid && rooms[rid]) {
            setTimeout(() => {
                if (rooms[rid] && rooms[rid].players.length === 0) delete rooms[rid];
            }, 5000);
        }
    });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
