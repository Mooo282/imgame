const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// إخبار السيرفر بأن مجلد public يحتوي على الملفات العامة (الصور)
app.use(express.static(path.join(__dirname, 'public')));

// قائمة الصور المحلية (تأكد من وجود هذه الملفات داخل مجلد public)
const allImages = [
    "/1.jpg", "/2.jpg", "/3.jpg", "/4.jpg", "/5.jpg", 
    "/6.jpg", "/7.jpg", "/8.jpg", "/9.jpg"
];

let players = [], scores = {}, playerNames = {}, hostId = null;
let currentRound = 0, totalRounds = 0, correctImage = "", currentDrawerId = null;
let fakeImages = {}, votes = {}, guessesReceived = 0, gameState = "LOBBY", socketToUserId = {};

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

function emitPlayerList() {
    io.emit('updatePlayerList', { players, playerNames, hostId, scores, gameState });
}

io.on('connection', (socket) => {
    socket.on('joinGame', (data) => {
        socketToUserId[socket.id] = data.userId;
        playerNames[data.userId] = data.name;
        if (scores[data.userId] === undefined) scores[data.userId] = 0;
        if (!players.includes(data.userId)) players.push(data.userId);
        if (!hostId) hostId = data.userId;
        emitPlayerList();
    });

    socket.on('requestStart', (data) => {
        if (socketToUserId[socket.id] === hostId) {
            totalRounds = parseInt(data.rounds) || 5;
            currentRound = 1; startNewRound();
        }
    });

    function startNewRound() {
        gameState = "DRAWING"; guessesReceived = 0; fakeImages = {}; votes = {};
        currentDrawerId = players[Math.floor(Math.random() * players.length)];
        let imgs = [...allImages].sort(() => 0.5 - Math.random()).slice(0, 9);
        io.emit('roundStarted', { images: imgs, drawerId: currentDrawerId, drawerName: playerNames[currentDrawerId] });
    }

    socket.on('submitClue', (data) => {
        correctImage = data.image; gameState = "FAKING";
        players.forEach(pId => {
            if (pId !== currentDrawerId) {
                const pImgs = [...allImages].sort(() => 0.5 - Math.random()).slice(0, 9);
                const sid = Object.keys(socketToUserId).find(k => socketToUserId[k] === pId);
                if(sid) io.to(sid).emit('showClue', { clue: data.clue, pImages: pImgs });
            }
        });
    });

    socket.on('submitFake', (img) => {
        fakeImages[socketToUserId[socket.id]] = img;
        guessesReceived++;
        if (guessesReceived >= (players.length - 1)) {
            gameState = "VOTING";
            let opts = [...new Set([correctImage, ...Object.values(fakeImages)])].sort(() => 0.5 - Math.random());
            io.emit('startVoting', { options: opts, drawerId: currentDrawerId });
        }
    });

    socket.on('submitVote', (img) => {
        votes[socketToUserId[socket.id]] = img;
        guessesReceived++;
        if (guessesReceived >= (players.length - 1)) {
            for(let id in votes) { if(votes[id] === correctImage) { scores[id] += 10; scores[currentDrawerId] += 5; } }
            emitPlayerList();
            io.emit('roundFinished', { correctImage });
            setTimeout(() => { if(currentRound < totalRounds) { currentRound++; startNewRound(); } }, 5000);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => console.log(`Server running on port ${PORT}`));
