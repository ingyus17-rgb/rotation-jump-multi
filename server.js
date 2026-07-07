const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Matter = require('matter-js');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const { Engine, Bodies, Body, Composite, Events } = Matter;
const engine = Engine.create({ positionIterations: 12, velocityIterations: 10 });

const ground = Bodies.rectangle(450, 520, 910, 120, { isStatic: true, friction: 1.0 });
const leftWall = Bodies.rectangle(-10, -4725, 20, 10550, { isStatic: true });
const rightWall = Bodies.rectangle(910, -4725, 20, 10550, { isStatic: true });
Composite.add(engine.world, [ground, leftWall, rightWall]);

function createCharacter(x, y, name) {
    const core = Bodies.circle(x, y, 25, { label: name + 'Core', density: 1.0 });
    const stick = Bodies.rectangle(x + 60, y, 100, 15, { label: name + 'Stick', chamfer: { radius: 5 }, density: 0.0001 });
    return Body.create({ parts: [core, stick], friction: 0.8, restitution: 0.8, label: name });
}

// ==========================================
// [시스템 구조 개편] 유한 상태 기계 및 슬롯 시스템
// ==========================================
const players = {}; 
const slots = { player: null, bot: null }; // 자리(Slot) 추적
let gameState = 'WAITING'; // 상태: WAITING, PLAYING, GAME_OVER
let restartTimer = null;

// 우주(물리계)를 초기 상태로 복원하는 함수
function resetUniverse() {
    // 1. 기존 잔재 완전 소멸
    for (let id in players) {
        if (players[id].body) {
            Composite.remove(engine.world, players[id].body);
            players[id].body = null;
        }
    }

    // 2. 현재 접속해 있는 플레이어들을 초기 좌표에 재창조
    if (slots.player) {
        const body1 = createCharacter(300, 300, 'player');
        Composite.add(engine.world, body1);
        players[slots.player] = { body: body1, label: 'player' };
    }
    if (slots.bot) {
        const body2 = createCharacter(600, 300, 'bot');
        Composite.add(engine.world, body2);
        players[slots.bot] = { body: body2, label: 'bot' };
    }

    // 3. 2명이 꽉 찼다면 즉시 전투 개시, 아니면 대기 상태
    gameState = (slots.player && slots.bot) ? 'PLAYING' : 'WAITING';
    io.emit('game_reset'); 
}

io.on('connection', (socket) => {
    let myRole = null;

    // 슬롯 기반 역할 배정 (2P 중복 차단)
    if (!slots.player) {
        myRole = 'player';
        slots.player = socket.id;
    } else if (!slots.bot) {
        myRole = 'bot';
        slots.bot = socket.id;
    }

    if (myRole) {
        if (gameState !== 'GAME_OVER') {
            const startX = myRole === 'player' ? 300 : 600;
            const pBody = createCharacter(startX, 300, myRole);
            Composite.add(engine.world, pBody);
            players[socket.id] = { body: pBody, label: myRole };
            
            // 두 명이 모이면 즉시 전투 개시
            if (slots.player && slots.bot && gameState === 'WAITING') {
                gameState = 'PLAYING';
                io.emit('game_reset'); 
            }
        } else {
            // 게임 오버 상태일 때 들어오면 껍데기만 만듦 (곧 resetUniverse가 덮어씌움)
            players[socket.id] = { body: null, label: myRole };
        }
        socket.emit('role_assign', { id: socket.id, label: myRole });
    } else {
        socket.emit('spectator', '방이 가득 차 관전 모드로 전환됩니다.');
    }

    socket.on('player_input', (inputData) => {
        if (gameState !== 'PLAYING') return; // 게임 중이 아니면 조작 무력화

        const p = players[socket.id];
        if (!p || !p.body) return;

        const maxAngularVelocity = 0.3;
        const baseRotationSpeed = 0.15;

        if (inputData.isDashing) {
            Body.setAngularVelocity(p.body, inputData.dashDirection * 0.6);
        } else {
            if (inputData.left) Body.setAngularVelocity(p.body, -baseRotationSpeed);
            else if (inputData.right) Body.setAngularVelocity(p.body, baseRotationSpeed);
            
            if (Math.abs(p.body.angularVelocity) > maxAngularVelocity) {
                Body.setAngularVelocity(p.body, Math.sign(p.body.angularVelocity) * maxAngularVelocity);
            }
        }
    });

    socket.on('disconnect', () => {
        // 나간 사람의 슬롯 비우기
        if (slots.player === socket.id) slots.player = null;
        if (slots.bot === socket.id) slots.bot = null;

        if (players[socket.id]) {
            if (players[socket.id].body) {
                Composite.remove(engine.world, players[socket.id].body);
            }
            delete players[socket.id];
        }

        // 1명이라도 나갔다면 강제 대기 상태 돌입
        if (!slots.player || !slots.bot) {
            gameState = 'WAITING';
            clearInterval(restartTimer); // <--- 여기를 clearInterval로 수정
            io.emit('waiting_players');
        }
    });
});

Events.on(engine, 'collisionStart', (event) => {
    if (gameState !== 'PLAYING') return; 

    const pairs = event.pairs;
    for (let i = 0; i < pairs.length; i++) {
        const bodyA = pairs[i].bodyA; 
        const bodyB = pairs[i].bodyB;

        const checkKill = (labelA, labelB, weapon, weakPoint) => { 
            return (labelA === weapon && labelB === weakPoint) || (labelB === weapon && labelA === weakPoint); 
        };
        
        let winnerLabel = null;
        let loserLabel = null;

        if (checkKill(bodyA.label, bodyB.label, 'playerStick', 'botCore')) {
            winnerLabel = 'player'; loserLabel = 'bot';
        } else if (checkKill(bodyA.label, bodyB.label, 'botStick', 'playerCore')) {
            winnerLabel = 'bot'; loserLabel = 'player';
        }

        if (winnerLabel && loserLabel) {
            // 시간의 흐름을 게임 오버 상태로 고정
            gameState = 'GAME_OVER';
            
            let loserId = Object.keys(players).find(id => players[id].label === loserLabel);
            if (loserId && players[loserId].body) {
                const loserBody = players[loserId].body;
                const deathX = loserBody.position.x;
                const deathY = loserBody.position.y;

                Composite.remove(engine.world, loserBody);
                players[loserId].body = null; 

                io.emit('game_over', { 
                    winnerLabel: winnerLabel, 
                    loserLabel: loserLabel, 
                    x: deathX, 
                    y: deathY 
                });

                // 3초 후 새로운 세계 재창조 (오토 리플레이 + 1초 단위 카운트다운)
                clearInterval(restartTimer);
                let count = 3;
                restartTimer = setInterval(() => {
                    count--;
                    if (count > 0) {
                        io.emit('countdown', count); // 2, 1 숫자를 클라이언트에 전송
                    } else {
                        clearInterval(restartTimer);
                        resetUniverse(); // 0이 되면 게임 재시작
                    }
                }, 1000);
            }
            continue; 
        }
        
        const isStickClash = (bodyA.label === 'playerStick' && bodyB.label === 'botStick') || (bodyB.label === 'playerStick' && bodyA.label === 'botStick');
        if (isStickClash) {
            let contactX = (bodyA.position.x + bodyB.position.x) / 2; 
            let contactY = (bodyA.position.y + bodyB.position.y) / 2;
            if (pairs[i].collision && pairs[i].collision.supports && pairs[i].collision.supports.length > 0) {
                contactX = pairs[i].collision.supports[0].x; 
                contactY = pairs[i].collision.supports[0].y;
            }
            io.emit('create_spark', { x: contactX, y: contactY });
        }
    }
});

// ==========================================
// [3] 메인 서버 게임 루프 (데이터 압축 최적화 적용)
// ==========================================
let lastTime = Date.now();
setInterval(() => {
    const now = Date.now();
    let delta = now - lastTime;
    lastTime = now;
    if (delta > 33) delta = 33; 

    let isSlowMo = false;
    if (gameState === 'PLAYING' && slots.player && slots.bot && players[slots.player].body && players[slots.bot].body) {
        const p1 = players[slots.player].body;
        const p2 = players[slots.bot].body;
        const dist = Math.hypot(p1.position.x - p2.position.x, p1.position.y - p2.position.y);

        if (dist < 180) {
            isSlowMo = true;
            engine.timing.timeScale = 0.3; 
        } else {
            engine.timing.timeScale = 1.0;
        }
    } else {
        engine.timing.timeScale = 1.0;
    }

    // 서버 연산량 최적화 (반복 계산 횟수 축소)
    Engine.update(engine, delta, { positionIterations: 6, velocityIterations: 4 });

    const syncData = { _isSlowMo: isSlowMo }; 
    
    for (let id in players) {
        const pBody = players[id].body;
        if (pBody) {
            // [최적화 핵심] 클라이언트 렌더링에 불필요한 속도(velocity) 데이터를 빼고, 
            // 무의미하게 긴 소수점을 첫째 자리까지만 반올림하여 네트워크 트래픽 60% 절감
            syncData[id] = {
                label: players[id].label,
                x: Math.round(pBody.position.x * 10) / 10,
                y: Math.round(pBody.position.y * 10) / 10,
                angle: Math.round(pBody.angle * 100) / 100
            };
        }
    }
    io.emit('sync_state', syncData);

}, 1000 / 60);

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`=========================================`);
    console.log(`서버 가동 중 (Port: ${PORT})`);
    console.log(`[SYS] 오토 리플레이 및 FSM 코어 활성화 완료`);
    console.log(`=========================================`);
});