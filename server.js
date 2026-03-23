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

// هيكل بيانات الغرف (كل غرفة هي كائن مستقل)
const gameRooms = {};

// دالة خلط المصفوفات
function shuffle(array) {
    let a = [...array];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

// دالة إنشاء بيانات الغرفة الجديدة
function initRoom(roomId) {
    if (!gameRooms[roomId]) {
        gameRooms[roomId] = {
            players: [], scores: {}, playerNames: {}, hostId: null,
            playerReady: {}, targetPoints: 30, roundTimeLimit: 60,
            currentDrawerId: null, currentPool: [], gameState: "LOBBY",
            currentImages: [], currentClue: "", correctImage: "",
            fakeImages: {}, votes: {}, drawerQueue: [], gameTimer: null
        };
    }
    return gameRooms[roomId];
}

function emitPlayerList(roomId) {
    const r = gameRooms[roomId];
    if (r) {
        io.to(roomId).emit('updatePlayerList', { 
            players: r.players, playerNames: r.playerNames, hostId: r.hostId, 
            scores: r.scores, gameState: r.gameState, currentDrawerId: r.currentDrawerId, 
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
        
        // تعيين الهوست للغرفة
        if (!r.hostId || !r.players.includes(r.hostId)) r.hostId = r.players[0];

        socket.emit('initRoom', roomId);

        // مزامنة حالة اللعبة للاعب المنضم (Hot-Join Sync)
        if (r.gameState !== "LOBBY") {
            if (r.gameState === "DRAWING") {
                socket.emit('roundStarted', { 
                    images: (uId === r.currentDrawerId ? r.currentImages : []), 
                    drawerId: r.currentDrawerId, 
                    drawerName: r.playerNames[r.currentDrawerId] 
                });
            } else if (r.gameState === "FAKING") {
                socket.emit('showClue', { clue: r.currentClue, pImages: (uId !== r.currentDrawerId ? shuffle(r.currentPool).filter(img => img !== r.correctImage).slice(0, 6) : []) });
            }
        }
        emitPlayerList(roomId);
    });

    // مؤشر الكتابة (Typing Indicator) لكل غرفة
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
            r.targetPoints = parseInt(data.targetPoints);
            r.roundTimeLimit = parseInt(data.roundTime);
            r.currentPool = imagePools[data.mode] || imagePools["classic"];
            startNewRound(socket.roomId);
        }
    });

    function startNewRound(roomId) {
        const r = gameRooms[roomId];
        r.gameState = "DRAWING"; r.fakeImages = {}; r.votes = {}; r.currentClue = "";
        if (r.drawerQueue.length === 0) r.drawerQueue = shuffle(r.players);
        r.currentDrawerId = r.drawerQueue.shift();
        r.currentImages = shuffle(r.currentPool).slice(0, 6);

        io.to(roomId).emit('roundStarted', { images: [], drawerId: r.currentDrawerId, drawerName: r.playerNames[r.currentDrawerId] });
        
        // إرسال الصور للرسام فقط
        io.to(roomId).fetchSockets().then(sockets => {
            const drawerSocket = sockets.find(s => s.userId === r.currentDrawerId);
            if (drawerSocket) drawerSocket.emit('roundStarted', { images: r.currentImages, drawerId: r.currentDrawerId, drawerName: r.playerNames[r.currentDrawerId] });
        });

        startTimer(roomId, r.roundTimeLimit, () => { if(r.gameState === "DRAWING") startNewRound(roomId); });
    }

    socket.on('submitClue', (data) => {
        const r = gameRooms[socket.roomId];
        if (!r || socket.userId !== r.currentDrawerId) return;
        r.gameState = "FAKING"; r.correctImage = data.image; r.currentClue = data.clue;
        io.to(socket.roomId).emit('showClue', { clue: r.currentClue, pImages: [] });
        startTimer(socket.roomId, r.roundTimeLimit, () => finalizeRound(socket.roomId));
    });

    socket.on('sendChat', (msg) => {
        if (socket.roomId) {
            io.to(socket.roomId).emit('newChat', { sender: gameRooms[socket.roomId].playerNames[socket.userId], text: msg });
        }
    });

    socket.on('disconnect', () => {
        const rid = socket.roomId;
        const uid = socket.userId;
        if (rid && gameRooms[rid]) {
            const r = gameRooms[rid];
            // مهلة 5 ثوانٍ قبل حذف اللاعب لضمان إمكانية العودة (Reconnection)
            setTimeout(() => {
                io.to(rid).fetchSockets().then(sockets => {
                    const isStillThere = sockets.some(s => s.userId === uid);
                    if (!isStillThere) {
                        r.players = r.players.filter(id => id !== uid);
                        if (r.players.length === 0) {
                            if(r.gameTimer) clearInterval(r.gameTimer);
                            delete gameRooms[rid];
                            console.log(`Room ${rid} closed.`);
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
    console.log(`PixDeception Multi-Room Server running on port ${PORT}`);
});
