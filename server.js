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

// متغيرات حالة اللعبة
let players = [], scores = {}, playerNames = {}, hostId = null;
let playerReady = {}, targetPoints = 30, roundTimeLimit = 60;
let currentDrawerId = null, currentPool = [], gameState = "LOBBY";
let currentImages = [], currentClue = "", correctImage = "";
let fakeImages = {}, votes = {}, socketToUserId = {}, drawerQueue = [];
let gameTimer = null;

// وظيفة خلط المصفوفات (Fisher-Yates) لضمان العشوائية المطلقة
function shuffle(array) {
    let a = [...array];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

function emitPlayerList() {
    io.emit('updatePlayerList', { players, playerNames, hostId, scores, gameState, currentDrawerId, playerReady });
}

function startTimer(duration, onTimeout) {
    if (gameTimer) clearInterval(gameTimer);
    let timeLeft = duration;
    io.emit('timerUpdate', timeLeft);
    gameTimer = setInterval(() => {
        timeLeft--;
        io.emit('timerUpdate', timeLeft);
        if (timeLeft <= 0) { 
            clearInterval(gameTimer); 
            if (onTimeout) onTimeout(); 
        }
    }, 1000);
}

io.on('connection', (socket) => {
    // عند انضمام لاعب
    socket.on('joinGame', (data) => {
        const uId = data.userId;
        socketToUserId[socket.id] = uId;
        playerNames[uId] = data.name;
        if (scores[uId] === undefined) scores[uId] = 0;
        if (playerReady[uId] === undefined) playerReady[uId] = false;
        if (!players.includes(uId)) players.push(uId);
        
        // تعيين الهوست إذا لم يكن موجوداً
        if (!hostId || !players.includes(hostId)) hostId = players[0];

        // مزامنة حالة اللعبة للاعب المنضم حديثاً (Hot-Join)
        if (gameState !== "LOBBY") {
            if (gameState === "DRAWING") {
                const imgs = (uId === currentDrawerId) ? currentImages : [];
                socket.emit('roundStarted', { images: imgs, drawerId: currentDrawerId, drawerName: playerNames[currentDrawerId] });
            } else if (gameState === "FAKING") {
                const pImages = shuffle(currentPool).filter(img => img !== correctImage).slice(0, 6);
                socket.emit('showClue', { clue: currentClue, pImages });
            } else if (gameState === "VOTING") {
                sendVotingOptions(socket.id);
            }
        }
        emitPlayerList();
    });

    socket.on('toggleReady', () => {
        const uId = socketToUserId[socket.id];
        if (uId) { playerReady[uId] = !playerReady[uId]; emitPlayerList(); }
    });

    // صلاحية الهوست لإنهاء المباراة
    socket.on('forceEndGame', () => {
        if (socketToUserId[socket.id] === hostId) {
            if (gameTimer) clearInterval(gameTimer);
            gameState = "LOBBY";
            players.forEach(id => { scores[id] = 0; playerReady[id] = false; });
            io.emit('gameResetByHost');
            emitPlayerList();
        }
    });

    socket.on('requestStart', (data) => {
        if (socketToUserId[socket.id] === hostId && gameState === "LOBBY") {
            targetPoints = parseInt(data.targetPoints);
            roundTimeLimit = parseInt(data.roundTime);
            currentPool = imagePools[data.mode] || imagePools["classic"];
            startNewRound();
        }
    });

    function startNewRound() {
        gameState = "DRAWING"; fakeImages = {}; votes = {}; currentClue = "";
        if (drawerQueue.length === 0) drawerQueue = shuffle(players);
        currentDrawerId = drawerQueue.shift();
        currentImages = shuffle(currentPool).slice(0, 6);

        // إرسال الصور للرسام فقط لضمان عدم تكرار الصور لدى البقية في هذه المرحلة
        players.forEach(pId => {
            const sid = Object.keys(socketToUserId).find(k => socketToUserId[k] === pId);
            if (sid) {
                const imgs = (pId === currentDrawerId) ? currentImages : [];
                io.to(sid).emit('roundStarted', { 
                    images: imgs, 
                    drawerId: currentDrawerId, 
                    drawerName: playerNames[currentDrawerId] 
                });
            }
        });

        startTimer(roundTimeLimit, () => { if(gameState === "DRAWING") startNewRound(); });
    }

    socket.on('submitClue', (data) => {
        if (socketToUserId[socket.id] !== currentDrawerId) return;
        gameState = "FAKING"; correctImage = data.image; currentClue = data.clue;

        // إرسال التلميح وصور تضليل فريدة لكل لاعب
        players.forEach(pId => {
            const sid = Object.keys(socketToUserId).find(k => socketToUserId[k] === pId);
            if (sid) {
                if (pId !== currentDrawerId) {
                    const pImages = shuffle(currentPool).filter(img => img !== correctImage).slice(0, 6);
                    io.to(sid).emit('showClue', { clue: currentClue, pImages });
                } else {
                    io.to(sid).emit('showClue', { clue: currentClue, pImages: [] });
                }
            }
        });
        startTimer(roundTimeLimit, () => proceedToVoting());
    });

    socket.on('submitFake', (img) => {
        const uId = socketToUserId[socket.id];
        if (uId && uId !== currentDrawerId) fakeImages[uId] = img;
        if (Object.keys(fakeImages).length >= (players.length - 1)) proceedToVoting();
    });

    function proceedToVoting() {
        gameState = "VOTING";
        sendVotingOptions();
        startTimer(roundTimeLimit, () => finalizeRound());
    }

    function sendVotingOptions(targetId = null) {
        let opts = shuffle([...new Set([correctImage, ...Object.values(fakeImages)])]);
        // تكميل المصفوفة لـ 6 صور إذا كان العدد أقل
        while(opts.length < Math.min(6, currentPool.length)) {
            let rand = currentPool[Math.floor(Math.random()*currentPool.length)];
            if(!opts.includes(rand)) opts.push(rand);
        }
        const data = { options: shuffle(opts), drawerId: currentDrawerId };
        if(targetId) io.to(targetId).emit('startVoting', data);
        else io.emit('startVoting', data);
    }

    socket.on('submitVote', (img) => {
        const uId = socketToUserId[socket.id];
        if (uId && uId !== currentDrawerId) votes[uId] = img;
        if (Object.keys(votes).length >= (players.length - 1)) finalizeRound();
    });

    function finalizeRound() {
        if (gameTimer) clearInterval(gameTimer);
        gameState = "RESULTS";
        let total = players.length - 1, correct = 0;
        for (let vId in votes) if (votes[vId] === correctImage) correct++;
        
        // نظام النقاط المطور (Dixit Style)
        if (correct > 0 && correct < total) {
            scores[currentDrawerId] += (correct * 2);
            for (let vId in votes) if (votes[vId] === correctImage) scores[vId] += 2;
        } else if (correct === total) {
            // إذا عرف الجميع الصورة، المصوتون يأخذون 2 والرسام 0
            for (let vId in votes) scores[vId] += 2;
        }

        // نقاط الخداع (Bonus لمن خدع الآخرين بصورته)
        for (let vId in votes) {
            for (let fId in fakeImages) {
                if (votes[vId] === fakeImages[fId] && fId !== vId) scores[fId] += 1;
            }
        }

        // تجهيز تفاصيل الكشف
        let voteDetails = {}, fakers = {};
        for (let vId in votes) { 
            if (!voteDetails[votes[vId]]) voteDetails[votes[vId]] = []; 
            voteDetails[votes[vId]].push(playerNames[vId]); 
        }
        for (let fId in fakeImages) fakers[fakeImages[fId]] = playerNames[fId];

        io.emit('roundFinished', { correctImage, scores, voteDetails, fakers });
        emitPlayerList();

        setTimeout(() => {
            if (players.some(id => scores[id] >= targetPoints)) {
                const lb = players.map(id => ({ name: playerNames[id], score: scores[id] })).sort((a,b) => b.score - a.score);
                io.emit('gameOver', { leaderboard: lb });
                gameState = "LOBBY";
                emitPlayerList();
            } else if(players.length > 0) {
                startNewRound();
            }
        }, 8000);
    }

    socket.on('sendChat', (msg) => {
        const uId = socketToUserId[socket.id];
        if(uId) io.emit('newChat', { sender: playerNames[uId], text: msg });
    });

    socket.on('disconnect', () => {
        const sid = socket.id;
        const uId = socketToUserId[sid];
        delete socketToUserId[sid];

        if (uId && !Object.values(socketToUserId).includes(uId)) {
            setTimeout(() => {
                if (!Object.values(socketToUserId).includes(uId)) {
                    players = players.filter(id => id !== uId);
                    if (uId === hostId) hostId = players.length > 0 ? players[0] : null;
                    // إذا خرج الرسام أثناء دوره، ابدأ جولة جديدة
                    if (uId === currentDrawerId && gameState !== "LOBBY") startNewRound();
                    emitPlayerList();
                }
            }, 5000);
        }
    });
});

server.listen(PORT, () => {
    console.log(`PixDeception Server running on port ${PORT}`);
});
