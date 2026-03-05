const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" } // لضمان عمل الاتصال على Render بدون قيود
});

// روابط صور مستقرة ومتنوعة (Lorem Picsum) لضمان عدم الحظر
const allImages = Array.from({ length: 30 }, (_, i) => `https://picsum.photos{i + 10}/500/500`);

let players = [], scores = {}, playerNames = {}, hostId = null;
let currentRound = 0, totalRounds = 0, correctImage = "", currentDrawerId = null;
let fakeImages = {}, votes = {}, guessesReceived = 0, timer;
let gameState = "LOBBY"; // LOBBY, DRAWING, FAKING, VOTING, RESULTS
let socketToUserId = {};
let drawerQueue = [];

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

function emitPlayerList() {
    io.emit('updatePlayerList', { players, playerNames, hostId, scores, gameState });
}

function startTimer(duration, onTimeout) {
    clearInterval(timer);
    let timeLeft = duration;
    io.emit('timerUpdate', timeLeft);
    timer = setInterval(() => {
        timeLeft--;
        io.emit('timerUpdate', timeLeft);
        if (timeLeft <= 0) { 
            clearInterval(timer); 
            if (onTimeout) onTimeout(); 
        }
    }, 1000);
}

io.on('connection', (socket) => {
    // 1. انضمام اللاعب
    socket.on('joinGame', (data) => {
        const uId = data.userId;
        socketToUserId[socket.id] = uId;
        playerNames[uId] = data.name;
        if (scores[uId] === undefined) scores[uId] = 0;
        if (!players.includes(uId)) players.push(uId);
        if (!hostId) hostId = uId;
        emitPlayerList();
    });

    // 2. بدء اللعبة (للمضيف فقط)
    socket.on('requestStart', (data) => {
        if (socketToUserId[socket.id] === hostId && gameState === "LOBBY") {
            totalRounds = parseInt(data.rounds) || 5;
            currentRound = 1;
            drawerQueue = [...players].sort(() => 0.5 - Math.random());
            startNewRound();
        }
    });

    function startNewRound() {
        gameState = "DRAWING";
        guessesReceived = 0;
        fakeImages = {};
        votes = {};
        
        if (drawerQueue.length === 0) drawerQueue = [...players].sort(() => 0.5 - Math.random());
        currentDrawerId = drawerQueue.shift();

        // اختيار 9 صور عشوائية للجولة
        const roundImages = [...allImages].sort(() => 0.5 - Math.random()).slice(0, 9);
        
        io.emit('roundStarted', { 
            images: roundImages, 
            drawerId: currentDrawerId, 
            drawerName: playerNames[currentDrawerId],
            currentRound 
        });
        
        startTimer(60, () => { if(gameState === "DRAWING") startNewRound(); });
    }

    // 3. إرسال التلميح (المشفر)
    socket.on('submitClue', (data) => {
        if (socketToUserId[socket.id] !== currentDrawerId) return;
        correctImage = data.image;
        gameState = "FAKING";
        
        players.forEach(pId => {
            if (pId !== currentDrawerId) {
                const pImages = [...allImages].sort(() => 0.5 - Math.random()).slice(0, 9);
                const sid = Object.keys(socketToUserId).find(k => socketToUserId[k] === pId);
                if(sid) io.to(sid).emit('showClue', { 
                    clue: data.clue, 
                    pImages: pImages, 
                    drawerName: playerNames[currentDrawerId] 
                });
            }
        });
        startTimer(60, () => proceedToVoting());
    });

    // 4. إرسال صورة التضليل (بقية اللاعبين)
    socket.on('submitFake', (image) => {
        const uId = socketToUserId[socket.id];
        if (uId === currentDrawerId || fakeImages[uId]) return;
        fakeImages[uId] = image;
        guessesReceived++;
        if (guessesReceived >= (players.length - 1)) proceedToVoting();
    });

    function proceedToVoting() {
        gameState = "VOTING";
        guessesReceived = 0;
        // دمج الصورة الصحيحة مع صور التضليل
        let options = [correctImage, ...Object.values(fakeImages)];
        let finalOptions = [...new Set(options)].sort(() => 0.5 - Math.random());
        
        io.emit('startVoting', { options: finalOptions, drawerId: currentDrawerId });
        startTimer(60, () => finalizeRound());
    }

    // 5. التصويت النهائي
    socket.on('submitVote', (votedImage) => {
        const uId = socketToUserId[socket.id];
        if (uId === currentDrawerId || votes[uId]) return;
        votes[uId] = votedImage;
        guessesReceived++;
        if (guessesReceived >= (players.length - 1)) finalizeRound();
    });

    function finalizeRound() {
        gameState = "RESULTS";
        let voteDetails = {};
        
        // حساب النقاط
        for (let vId in votes) {
            const img = votes[vId];
            if (!voteDetails[img]) voteDetails[img] = [];
            voteDetails[img].push(playerNames[vId]);
            
            if (img === correctImage) {
                scores[vId] += 10; // المصوت صحيحاً
                scores[currentDrawerId] += 5; // المشفر الناجح
            } else {
                // اللاعب الذي نجح في التضليل
                for (let fId in fakeImages) {
                    if (fakeImages[fId] === img) scores[fId] += 7;
                }
            }
        }

        emitPlayerList();
        io.emit('roundFinished', { correctImage, voteDetails });

        setTimeout(() => {
            if (currentRound < totalRounds) {
                currentRound++;
                startNewRound();
            } else {
                const leaderboard = players.map(id => ({ name: playerNames[id], score: scores[id] })).sort((a, b) => b.score - a.score);
                io.emit('gameOver', { leaderboard });
                gameState = "LOBBY";
            }
        }, 8000);
    }

    socket.on('disconnect', () => {
        const uId = socketToUserId[socket.id];
        if (uId) {
            players = players.filter(id => id !== uId);
            if (uId === hostId) hostId = players.length > 0 ? players[0] : null;
            delete socketToUserId[socket.id];
            emitPlayerList();
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
