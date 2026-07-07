const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Matter = require('matter-js');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const { Engine, Bodies, Body, Composite, Events } = Matter;

// [복구 1] game26.html과 정확히 동일한 엔진 연산 정밀도 (가볍고 빠릿함)
const engine = Engine.create({ positionIterations: 12, velocityIterations: 10 });

const ground = Bodies.rectangle(450, 520, 910, 120, { isStatic: true, friction: 1.0 });
const ceiling = Bodies.rectangle(450, -100, 910, 100, { isStatic: true }); 
const leftWall = Bodies.rectangle(-10, -4725, 20, 10550, { isStatic: true });
const rightWall = Bodies.rectangle(910, -4725, 20, 10550, { isStatic: true });
Composite.add(engine.world, [ground, ceiling, leftWall, rightWall]);

function createCharacter(x, y, name) {
    const core = Bodies.circle(x, y, 25, { label: name + 'Core', density: 1.0 });
    
    // [복구 2] game26.html과 정확히 일치하는 두께(15), 둥글기(5)
    // isBullet 속성 제거로 둔탁해지는 타격감 복구
    const stick = Bodies.rectangle(x + 60, y, 100, 15, { label: name + 'Stick', chamfer: { radius: 5 }, density: 0.0001 });
    return Body.create({ parts: [core, stick], friction: 0.8, restitution: 0.8, label: name });
}

let players = {}; 
const slots = { player: null, bot: null }; 
let gameState = 'WAITING'; 
let restartTimer = null;

const aiState = { active: false };

function resetUniverse() {
    for (let id in players) {
        if (players[id].body) Composite.remove(engine.world, players[id].body);
    }
    players = {}; 

    if (slots.player) {
        const body1 = createCharacter(300, 300, 'player');
        Composite.add(engine.world, body1);
        // [복구 3] 대시 상태 변수 초기화 (game26 스타일)
        players[slots.player] = { body: body1, label: 'player', keys: {}, isDashing: false, dashDirection: 1, dashEndTime: 0 };
    }

    if (slots.bot) {
        const body2 = createCharacter(600, 300, 'bot');
        Body.setAngle(body2, Math.PI); 
        Composite.add(engine.world, body2);
        players[slots.bot] = { body: body2, label: 'bot', keys: {}, isDashing: false, dashDirection: 1, dashEndTime: 0 };
        aiState.active = false; 
    } else if (slots.player) {
        const aiBody = createCharacter(600, 300, 'bot');
        Body.setAngle(aiBody, Math.PI); 
        Composite.add(engine.world, aiBody);
        players['AI_BOT'] = { body: aiBody, label: 'bot', keys: {}, isDashing: false, dashDirection: 1, dashEndTime: 0 };
        aiState.active = true; 
    }

    gameState = (slots.player) ? 'PLAYING' : 'WAITING';
    io.emit('game_reset'); 
}

io.on('connection', (socket) => {
    let myRole = null;

    if (!slots.player) { myRole = 'player'; slots.player = socket.id; } 
    else if (!slots.bot) { myRole = 'bot'; slots.bot = socket.id; }

    if (myRole) {
        socket.emit('role_assign', { id: socket.id, label: myRole });
        io.emit('receive_msg', { role: 'sys', msg: `${myRole === 'player' ? '1P' : '2P'} 님이 전장에 합류했습니다!` });
        
        if (myRole === 'bot' && aiState.active) {
            io.emit('receive_msg', { role: 'sys', msg: '새로운 도전자 접속! 훈련용 AI가 소멸합니다.' });
        } else if (myRole === 'player' && !slots.bot) {
            io.emit('receive_msg', { role: 'sys', msg: '상대방을 기다리는 동안 AI와 대련하세요.' });
        }
        resetUniverse(); 
    } else {
        socket.emit('spectator', '방이 가득 차 관전 모드로 전환됩니다.');
    }

    socket.on('send_msg', (msg) => {
        let currentRole = 'spectator';
        if (slots.player === socket.id) currentRole = 'player';
        else if (slots.bot === socket.id) currentRole = 'bot';
        io.emit('receive_msg', { role: currentRole, msg: msg });
    });

    socket.on('player_input', (keys) => {
        const p = players[socket.id];
        if (p) p.keys = keys;
    });

    socket.on('do_dash', (dir) => {
        if (gameState !== 'PLAYING') return;
        const p = players[socket.id];
        if (p && !p.isDashing) {
            // [복구 4] game26.html 방식의 대시 타이머 설정 (엔진 내부 시간 기준 +180ms)
            p.isDashing = true;
            p.dashDirection = dir;
            p.dashEndTime = engine.timing.timestamp + 180;
        }
    });

    socket.on('disconnect', () => {
        let leftRole = null;
        if (slots.player === socket.id) { slots.player = null; leftRole = '1P'; }
        if (slots.bot === socket.id) { slots.bot = null; leftRole = '2P'; }

        if (!leftRole) return; 

        io.emit('receive_msg', { role: 'sys', msg: `${leftRole} 님이 도망쳤습니다.` });

        if (!slots.player && slots.bot) {
            slots.player = slots.bot;
            slots.bot = null;
            io.to(slots.player).emit('role_assign', { id: slots.player, label: 'player' });
            io.emit('receive_msg', { role: 'sys', msg: `상대방이 나가서 1P로 변경되었습니다. 훈련용 AI를 가동합니다.` });
        }

        if (!slots.player) {
            gameState = 'WAITING';
            aiState.active = false;
            for (let id in players) {
                if (players[id].body) Composite.remove(engine.world, players[id].body);
            }
            players = {}; 
            clearInterval(restartTimer); 
        } else {
            resetUniverse(); 
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

        if (checkKill(bodyA.label, bodyB.label, 'playerStick', 'botCore')) { winnerLabel = 'player'; loserLabel = 'bot'; } 
        else if (checkKill(bodyA.label, bodyB.label, 'botStick', 'playerCore')) { winnerLabel = 'bot'; loserLabel = 'player'; }

        if (winnerLabel && loserLabel) {
            gameState = 'GAME_OVER';
            let loserId = Object.keys(players).find(id => players[id].label === loserLabel);
            if (loserId && players[loserId].body) {
                const loserBody = players[loserId].body;
                const deathX = loserBody.position.x;
                const deathY = loserBody.position.y;

                Composite.remove(engine.world, loserBody);
                players[loserId].body = null; 

                io.emit('game_over', { winnerLabel, loserLabel, x: deathX, y: deathY });

                clearInterval(restartTimer);
                let count = 3;
                restartTimer = setInterval(() => {
                    count--;
                    if (count > 0) io.emit('countdown', count); 
                    else { clearInterval(restartTimer); resetUniverse(); }
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

let lastTime = Date.now();
setInterval(() => {
    const now = Date.now();
    let delta = now - lastTime;
    lastTime = now;
    if (delta > 33) delta = 33; 

    let isSlowMo = false;
    if (gameState === 'PLAYING') {
        let p1Body = players[slots.player] ? players[slots.player].body : null;
        let p2Body = slots.bot && players[slots.bot] ? players[slots.bot].body : (players['AI_BOT'] ? players['AI_BOT'].body : null);
        
        if (p1Body && p2Body) {
            const dist = Math.hypot(p1Body.position.x - p2Body.position.x, p1Body.position.y - p2Body.position.y);
            if (dist < 180) { isSlowMo = true; engine.timing.timeScale = 0.3; } 
            else { engine.timing.timeScale = 1.0; }
        }
    } else { engine.timing.timeScale = 1.0; }

    const engineTime = engine.timing.timestamp;

    for (let id in players) {
        const p = players[id];
        if (!p.body || gameState !== 'PLAYING') continue;

        // AI 로직
        if (id === 'AI_BOT' && aiState.active) {
            let p1Body = players[slots.player] ? players[slots.player].body : null;
            if (p1Body) {
                let dx = p1Body.position.x - p.body.position.x;
                let aiSpeedX = p.body.velocity.x;
                if (dx < -30 && aiSpeedX > -6) Body.setAngularVelocity(p.body, -0.15);
                else if (dx > 30 && aiSpeedX < 6) Body.setAngularVelocity(p.body, 0.15);
            }
            continue;
        }

        // [복구 5] game26.html과 정확히 동일한 대시 & 이동 로직
        if (p.isDashing) {
            if (engineTime >= p.dashEndTime) {
                p.isDashing = false;
            } else {
                Body.setAngularVelocity(p.body, p.dashDirection * 0.6);
            }
        } else if (p.keys) {
            const maxAngularVelocity = 0.3;
            const baseRotationSpeed = 0.15;
            
            if (p.keys.left) Body.setAngularVelocity(p.body, -baseRotationSpeed);
            else if (p.keys.right) Body.setAngularVelocity(p.body, baseRotationSpeed);
            
            if (Math.abs(p.body.angularVelocity) > maxAngularVelocity) {
                Body.setAngularVelocity(p.body, Math.sign(p.body.angularVelocity) * maxAngularVelocity);
            }
        }
    }

    // [복구 6] 서브 스텝 제거 -> 단 1번만 업데이트하여 마찰력 버그 제거
    Engine.update(engine, delta);

    const syncData = { _isSlowMo: isSlowMo }; 
    for (let id in players) {
        const pBody = players[id].body;
        if (pBody) {
            syncData[id] = { label: players[id].label, x: pBody.position.x, y: pBody.position.y, angle: pBody.angle };
        }
    }
    io.emit('sync_state', syncData);

}, 1000 / 60);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`서버 가동 중 (Port: ${PORT})`);
});
