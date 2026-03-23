const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;

// إعداد المسارات والمجلدات العامة
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

// هيكل بيانات الغرف
const gameRooms = {};

// وظيفة خلط المصفوفات
function shuffle(array) {
    let a = [...array];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

// إنشاء بيانات الغرفة
function initRoom(roomId) {
    if (!gameRooms[roomId]) {
        gameRooms[roomId] = {
            players: [],
            scores: {},
            playerNames: {},
            hostId: null,
            playerReady: {},
            targetPoints: 30,
            roundTimeLimit: 60,
            currentDrawerId: null,
            currentPool: [],
            gameState: "LOBBY",
            currentImages: [],
            currentClue: "",
            correctImage: "",
            fakeImages: {},
            votes: {},
            drawerQueue: [],
            gameTimer: null
        };
    }
    return gameRooms[roomId];
}

function emitPlayerList(roomId) {
    const r = gameRooms[roomId];
    if (r) {
        io.to(roomId).emit('updatePlayerList', { 
            players: r.players, 
            playerNames: r.playerNames, 
            hostId: r.hostId, 
            scores: r.scores, 
            gameState: r.gameState, 
            currentDrawerId: r.currentDrawerId, 
            playerReady: r.playerReady 
        });
    }
}

function startTimer(roomId, duration, onTimeout) {
    const r = gameRooms[roomId];
    if (r.gameTimer) clearInterval(r.gameTimer);
    let timeLeft = duration;
    io.to(roomId).emit('timerUpdate', timeLeft);
    r.gameTimer = setInterval(() => {
        timeLeft--;
        io.to(roomId).emit('timerUpdate', timeLeft);
        if (timeLeft <= 0) { 
            clearInterval(r.gameTimer); 
            if (onTimeout) onTimeout(); 
        }
    }, 1000);
}

io.on('connection', (socket) => {
    
    socket.on('joinGame', (data) => {
        const uId = data.userId;
        const roomId = data.room || "PUBLIC";
        
        socket.join(roomId);
        socket.roomId = roomId;
        socket.userId = uId;

        const r = initRoom(roomId);
        r.playerNames[uId] = data.name;
        if (r.scores[uId] === undefined) r.scores[uId] = 0;
        if (r.playerReady[uId] === undefined) r.playerReady[uId] = false;
        if (!r.players.includes(uId)) r.players.push(uId);
        
        if (!r.hostId || !r.players.includes(r.hostId)) r.hostId = r.players[0];

        socket.emit('initRoom', roomId);
        emitPlayerList(roomId);
    });

    socket.on('typing', (isTyping) => {
        if (socket.roomId) {
            socket.broadcast.to(socket.roomId).emit('playerTyping', { userId: socket.userId, isTyping });
        }
    });

    socket.on('toggleReady', () => {
        const r = gameRooms[socket.roomId];
        if (r && socket.userId) { 
            r.playerReady[socket.userId] = !r.playerReady[socket.userId]; 
            emitPlayerList(socket.roomId); 
        }
    });

    socket.on('requestStart', (data) => {
        const r = gameRooms[socket.roomId];
        if (r && socket.userId === r.hostId && r.gameState === "LOBBY") {
            r.targetPoints = parseInt(data.targetPoints) || 30;
            r.roundTimeLimit = parseInt(data.roundTime) || 60;
            r.currentPool = imagePools[data.mode] || imagePools["classic"];
            startNewRound(socket.roomId);
        }
    });

    function startNewRound(roomId) {
        const r = gameRooms[roomId];
        r.gameState = "DRAWING"; 
        r.fakeImages = {}; 
        r.votes = {}; 
        r.currentClue = "";
        
        if (r.drawerQueue.length === 0) r.drawerQueue = shuffle(r.players);
        r.currentDrawerId = r.drawerQueue.shift();
        r.currentImages = shuffle(r.currentPool).slice(0, 6);

        io.to(roomId).emit('roundStarted', { 
            images: [], 
            drawerId: r.currentDrawerId, 
            drawerName: r.playerNames[r.currentDrawerId] 
        });
        
        io.in(roomId).fetchSockets().then(sockets => {
            const drawerSocket = sockets.find(s => s.userId === r.currentDrawerId);
            if (drawerSocket) {
                drawerSocket.emit('roundStarted', { 
                    images: r.currentImages, 
                    drawerId: r.currentDrawerId, 
                    drawerName: r.playerNames[r.currentDrawerId] 
                });
            }
        });

        startTimer(roomId, r.roundTimeLimit, () => { 
            if(r.gameState === "DRAWING") startNewRound(roomId); 
        });
    }

    socket.on('submitClue', (data) => {
        const r = gameRooms[socket.roomId];
        if (!r || socket.userId !== r.currentDrawerId) return;
        
        r.gameState = "FAKING"; 
        r.correctImage = data.image; 
        r.currentClue = data.clue;

        r.players.forEach(pId => {
            if (pId !== r.currentDrawerId) {
                const pImages = shuffle(r.currentPool).filter(img => img !== r.correctImage).slice(0, 6);
                io.in(socket.roomId).fetchSockets().then(sockets => {
                    const s = sockets.find(x => x.userId === pId);
                    if(s) s.emit('showClue', { clue: r.currentClue, pImages: pImages });
                });
            } else {
                io.in(socket.roomId).fetchSockets().then(sockets => {
                    const s = sockets.find(x => x.userId === pId);
                    if(s) s.emit('showClue', { clue: r.currentClue, pImages: [] });
                });
            }
        });

        startTimer(socket.roomId, r.roundTimeLimit, () => proceedToVoting(socket.roomId));
    });

    socket.on('submitFake', (img) => {
        const r = gameRooms[socket.roomId];
        if (r && socket.userId !== r.currentDrawerId) {
            r.fakeImages[socket.userId] = img;
        }
        if (r && Object.keys(r.fakeImages).length >= (r.players.length - 1)) {
            proceedToVoting(socket.roomId);
        }
    });

    function proceedToVoting(roomId) {
        const r = gameRooms[roomId];
        r.gameState = "VOTING";
        
        let opts = shuffle([...new Set([r.correctImage, ...Object.values(r.fakeImages)])]);
        while(opts.length < Math.min(6, r.currentPool.length)) {
            let rand = r.currentPool[Math.floor(Math.random() * r.currentPool.length)];
            if(!opts.includes(rand)) opts.push(rand);
        }
        
        io.to(roomId).emit('startVoting', { 
            options: shuffle(opts), 
            drawerId: r.currentDrawerId 
        });
        
        startTimer(roomId, r.roundTimeLimit, () => finalizeRound(roomId));
    }

    socket.on('submitVote', (img) => {
        const r = gameRooms[socket.roomId];
        if (r && socket.userId !== r.currentDrawerId) {
            r.votes[socket.userId] = img;
        }
        if (r && Object.keys(r.votes).length >= (r.players.length - 1)) {
            finalizeRound(socket.roomId);
        }
    });

    function finalizeRound(roomId) {
        const r = gameRooms[roomId];
        if (r.gameTimer) clearInterval(r.gameTimer);
        r.gameState = "RESULTS";
        
        let total = r.players.length - 1;
        let correct = 0;
        for (let vId in r.votes) {
            if (r.votes[vId] === r.correctImage) correct++;
        }
        
        // نظام النقاط (Dixit Style)
        if (correct > 0 && correct < total) {
            r.scores[r.currentDrawerId] += (correct * 2);
            for (let vId in r.votes) {
                if (r.votes[vId] === r.correctImage) r.scores[vId] += 2;
            }
        } else if (correct === total || correct === 0) {
            for (let vId in r.votes) {
                if (r.votes[vId] === r.correctImage) r.scores[vId] += 2;
            }
        }

        for (let vId in r.votes) {
            for (let fId in r.fakeImages) {
                if (r.votes[vId] === r.fakeImages[fId] && fId !== vId) {
                    r.scores[fId] += 1;
                }
            }
        }

        let voteDetails = {};
        let fakers = {};
        for (let vId in r.votes) { 
            if (!voteDetails[r.votes[vId]]) voteDetails[r.votes[vId]] = []; 
            voteDetails[r.votes[vId]].push(r.playerNames[vId]); 
        }
        for (let fId in r.fakeImages) {
            fakers[r.fakeImages[fId]] = r.playerNames[fId];
        }

        io.to(roomId).emit('roundFinished', { 
            correctImage: r.correctImage, 
            scores: r.scores, 
            voteDetails, 
            fakers 
        });

        setTimeout(() => {
            if (r.players.some(id => r.scores[id] >= r.targetPoints)) {
                const lb = r.players.map(id => ({ 
                    name: r.playerNames[id], 
                    score: r.scores[id] 
                })).sort((a,b) => b.score - a.score);
                io.to(roomId).emit('gameOver', { leaderboard: lb });
                r.gameState = "LOBBY";
            } else if(r.players.length > 0) {
                startNewRound(roomId);
            }
        }, 8000);
    }

    socket.on('sendChat', (msg) => {
        if (socket.roomId) {
            io.to(socket.roomId).emit('newChat', { 
                sender: gameRooms[socket.roomId].playerNames[socket.userId], 
                text: msg 
            });
        }
    });

    socket.on('disconnect', () => {
        const rid = socket.roomId;
        const uid = socket.userId;
        if (rid && gameRooms[rid]) {
            setTimeout(() => {
                io.in(rid).fetchSockets().then(sockets => {
                    if (!sockets.some(s => s.userId === uid)) {
                        const r = gameRooms[rid];
                        r.players = r.players.filter(id => id !== uid);
                        if (r.players.length === 0) {
                            if(r.gameTimer) clearInterval(r.gameTimer);
                            delete gameRooms[rid];
                        } else {
                            if (uid === r.hostId) r.hostId = r.players[0];
                            emitPlayerList(rid);
                        }
                    }
                });
            }, 5000);
        }
    });
});

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
