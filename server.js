const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;

// إعداد المسارات العامة
app.use(express.static(path.join(__dirname)));
app.use('/images', express.static(path.join(__dirname, 'public/images')));

// خزان الصور الافتراضي (تأكد من وجود الصور في هذه المسارات)
const imagePools = {
    "classic": Array.from({length: 50}, (_, i) => `/images/classic/${i+1}.jpg`),
    "fun": Array.from({length: 50}, (_, i) => `/images/fun/${i+1}.jpg`)
};

// مخزن الغرف (كل البيانات معزولة داخل كل غرفة)
const rooms = {};

// وظيفة خلط المصفوفات
function shuffle(array) {
    let a = [...array];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

io.on('connection', (socket) => {

    // انضمام لاعب لغرفة محددة أو إنشاء واحدة
    socket.on('joinGame', (data) => {
        const { roomId, userId, name } = data;
        socket.join(roomId);
        socket.roomId = roomId;
        socket.userId = userId;

        // تهيئة الغرفة إذا كانت جديدة
        if (!rooms[roomId]) {
            rooms[roomId] = {
                players: [], 
                scores: {}, 
                playerNames: {}, 
                hostId: userId,
                playerReady: {}, 
                gameState: "LOBBY", 
                currentDrawerId: null,
                currentPool: [], 
                drawerQueue: [], 
                fakeImages: {}, 
                votes: {},
                currentClue: "", 
                correctImage: "", 
                gameTimer: null, 
                roundTimeLimit: 60, 
                targetPoints: 30
            };
        }

        const room = rooms[roomId];
        room.playerNames[userId] = name;
        if (!room.players.includes(userId)) room.players.push(userId);
        if (room.scores[userId] === undefined) room.scores[userId] = 0;
        if (room.playerReady[userId] === undefined) room.playerReady[userId] = false;

        emitPlayerList(roomId);
    });

    function emitPlayerList(rId) {
        const room = rooms[rId];
        if (room) {
            io.to(rId).emit('updatePlayerList', { 
                players: room.players, 
                playerNames: room.playerNames, 
                hostId: room.hostId, 
                scores: room.scores, 
                gameState: room.gameState, 
                currentDrawerId: room.currentDrawerId, 
                playerReady: room.playerReady, 
                roomId: rId
            });
        }
    }

    socket.on('toggleReady', () => {
        const room = rooms[socket.roomId];
        if (room && socket.userId) {
            room.playerReady[socket.userId] = !room.playerReady[socket.userId];
            emitPlayerList(socket.roomId);
        }
    });

    socket.on('requestStart', (data) => {
        const room = rooms[socket.roomId];
        if (room && socket.userId === room.hostId && room.gameState === "LOBBY") {
            room.targetPoints = parseInt(data.targetPoints) || 30;
            room.roundTimeLimit = parseInt(data.roundTime) || 60;
            room.currentPool = imagePools[data.mode] || imagePools["classic"];
            startNewRound(socket.roomId);
        }
    });

    function startNewRound(rId) {
        const room = rooms[rId];
        if (!room) return;
        room.gameState = "DRAWING"; 
        room.fakeImages = {}; 
        room.votes = {}; 
        room.currentClue = "";
        
        if (room.drawerQueue.length === 0) room.drawerQueue = shuffle(room.players);
        room.currentDrawerId = room.drawerQueue.shift();
        
        const roundImages = shuffle(room.currentPool).slice(0, 6);

        // إرسال الصور للرسام فقط
        room.players.forEach(pId => {
            const sid = Array.from(io.sockets.adapter.rooms.get(rId) || []).find(s => io.sockets.sockets.get(s).userId === pId);
            if (sid) {
                const imgs = (pId === room.currentDrawerId) ? roundImages : [];
                io.to(sid).emit('roundStarted', { 
                    images: imgs, 
                    drawerId: room.currentDrawerId, 
                    drawerName: room.playerNames[room.currentDrawerId] 
                });
            }
        });

        startTimer(rId, room.roundTimeLimit, () => { 
            if(room.gameState === "DRAWING") startNewRound(rId); 
        });
    }

    socket.on('submitClue', (data) => {
        const room = rooms[socket.roomId];
        if (!room || socket.userId !== room.currentDrawerId) return;
        room.gameState = "FAKING"; 
        room.correctImage = data.image; 
        room.currentClue = data.clue;

        // إرسال التلميح وصور التمويه للاعبين
        room.players.forEach(pId => {
            const sid = Array.from(io.sockets.adapter.rooms.get(socket.roomId) || []).find(s => io.sockets.sockets.get(s).userId === pId);
            if (sid) {
                const pImages = (pId !== room.currentDrawerId) ? 
                    shuffle(room.currentPool).filter(img => img !== room.correctImage).slice(0, 6) : [];
                io.to(sid).emit('showClue', { 
                    clue: room.currentClue, 
                    pImages: pImages, 
                    drawerId: room.currentDrawerId 
                });
            }
        });
        startTimer(socket.roomId, room.roundTimeLimit, () => proceedToVoting(socket.roomId));
    });

    socket.on('submitFake', (img) => {
        const room = rooms[socket.roomId];
        if (room && room.gameState === "FAKING" && socket.userId !== room.currentDrawerId) {
            room.fakeImages[socket.userId] = img;
            if (Object.keys(room.fakeImages).length >= (room.players.length - 1)) {
                proceedToVoting(socket.roomId);
            }
        }
    });

    function proceedToVoting(rId) {
        const room = rooms[rId];
        if (!room || room.gameState !== "FAKING") return;
        room.gameState = "VOTING";
        
        let options = shuffle([...new Set([room.correctImage, ...Object.values(room.fakeImages)])]);
        
        // تكميل المصفوفة لـ 6 خيارات عشوائية إذا لزم الأمر
        while(options.length < Math.min(6, room.currentPool.length)) {
            let rand = room.currentPool[Math.floor(Math.random() * room.currentPool.length)];
            if(!options.includes(rand)) options.push(rand);
        }
        
        io.to(rId).emit('startVoting', { 
            options: shuffle(options), 
            drawerId: room.currentDrawerId 
        });
        startTimer(rId, room.roundTimeLimit, () => finalizeRound(rId));
    }

    socket.on('submitVote', (img) => {
        const room = rooms[socket.roomId];
        if (room && room.gameState === "VOTING" && socket.userId !== room.currentDrawerId) {
            room.votes[socket.userId] = img;
            if (Object.keys(room.votes).length >= (room.players.length - 1)) {
                finalizeRound(socket.roomId);
            }
        }
    });

    function finalizeRound(rId) {
        const room = rooms[rId];
        if (!room || room.gameState !== "VOTING") return;
        if (room.gameTimer) clearInterval(room.gameTimer);
        room.gameState = "RESULTS";

        let totalVoters = room.players.length - 1;
        let correctVotes = 0;
        for (let vId in room.votes) if (room.votes[vId] === room.correctImage) correctVotes++;

        // حساب النقاط (Dixit Style)
        if (correctVotes > 0 && correctVotes < totalVoters) {
            room.scores[room.currentDrawerId] += (correctVotes * 2);
            for (let vId in room.votes) {
                if (room.votes[vId] === room.correctImage) room.scores[vId] += 2;
            }
        } else if (correctVotes === totalVoters || correctVotes === 0) {
            // الرسام لا يأخذ نقاطاً إذا كان التلميح سهلاً جداً أو صعباً جداً
            for (let vId in room.votes) {
                if (room.votes[vId] === room.correctImage) room.scores[vId] += 2;
            }
        }

        // نقاط الخداع (Bonus لمن صوّت الآخرون لصورتهم)
        for (let vId in room.votes) {
            for (let fId in room.fakeImages) {
                if (room.votes[vId] === room.fakeImages[fId] && fId !== vId) {
                    room.scores[fId] += 1;
                }
            }
        }

        // إرسال النتائج التفصيلية
        let voteDetails = {}, fakers = {};
        for (let vId in room.votes) { 
            const img = room.votes[vId];
            if (!voteDetails[img]) voteDetails[img] = []; 
            voteDetails[img].push(room.playerNames[vId]); 
        }
        for (let fId in room.fakeImages) fakers[room.fakeImages[fId]] = room.playerNames[fId];

        io.to(rId).emit('roundFinished', { 
            correctImage: room.correctImage, 
            scores: room.scores, 
            voteDetails, 
            fakers 
        });
        
        emitPlayerList(rId);

        // التحقق من الفوز أو الانتقال لجولة جديدة
        setTimeout(() => {
            if (room.players.some(id => room.scores[id] >= room.targetPoints)) {
                const leaderboard = room.players
                    .map(id => ({ name: room.playerNames[id], score: room.scores[id] }))
                    .sort((a,b) => b.score - a.score);
                io.to(rId).emit('gameOver', { leaderboard });
                room.gameState = "LOBBY";
                room.players.forEach(id => { room.scores[id] = 0; room.playerReady[id] = false; });
                emitPlayerList(rId);
            } else if(room.players.length > 0) {
                startNewRound(rId);
            }
        }, 8000);
    }

    function startTimer(rId, duration, onTimeout) {
        const room = rooms[rId];
        if (!room) return;
        if (room.gameTimer) clearInterval(room.gameTimer);
        let timeLeft = duration;
        io.to(rId).emit('timerUpdate', timeLeft);
        room.gameTimer = setInterval(() => {
            timeLeft--;
            io.to(rId).emit('timerUpdate', timeLeft);
            if (timeLeft <= 0) { 
                clearInterval(room.gameTimer); 
                if (onTimeout) onTimeout(); 
            }
        }, 1000);
    }

    socket.on('sendChat', (msg) => {
        const room = rooms[socket.roomId];
        if(room) {
            io.to(socket.roomId).emit('newChat', { 
                sender: room.playerNames[socket.userId], 
                text: msg 
            });
        }
    });

    socket.on('disconnect', () => {
        const rId = socket.roomId;
        const uId = socket.userId;
        if (rooms[rId]) {
            rooms[rId].players = rooms[rId].players.filter(id => id !== uId);
            if (rooms[rId].players.length === 0) {
                if (rooms[rId].gameTimer) clearInterval(rooms[rId].gameTimer);
                delete rooms[rId];
            } else {
                if (uId === rooms[rId].hostId) rooms[rId].hostId = rooms[rId].players[0];
                emitPlayerList(rId);
            }
        }
    });
});

server.listen(PORT, () => {
    console.log(`PixDeception Rooms Server running on port ${PORT}`);
});
