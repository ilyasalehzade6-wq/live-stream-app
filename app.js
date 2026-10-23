document.addEventListener('DOMContentLoaded', () => {
    let dbClient = null;
    try {
        if (window.supabase) {
            dbClient = window.supabase.createClient(
                "https://adufjdildmvvdyxfwyyu.supabase.co", 
                "sb_publishable_FjLySgXMkBzoxfG2RTh3vg_NYavRF-0" // ⚠️ در صورت امکان، این را با کلید anon جایگزین کنید
            );
        }
    } catch (e) { console.error("خطا در اتصال به سرور:", e); }

    const loginView = document.getElementById('login-view');
    const roomView = document.getElementById('room-view');
    const remoteVideo = document.getElementById('remote-video');
    const localVideo = document.getElementById('local-video');
    const videoFileInput = document.getElementById('video-file');
    const btnStartStream = document.getElementById('btn-start-stream');
    const waitingText = document.getElementById('waiting-text');
    const statusText = document.getElementById('connection-status');
    const btnLeave = document.getElementById('btn-leave');
    const btnHost = document.getElementById('btn-host');
    const btnJoin = document.getElementById('btn-join');
    
    const chatMessages = document.getElementById('chat-messages');
    const chatInput = document.getElementById('chat-input');
    const btnSend = document.getElementById('btn-send');
    const btnEmoji = document.getElementById('btn-emoji');
    const onlineUsersText = document.getElementById('online-users');
    const reactionBar = document.getElementById('reaction-bar');
    const btnFullscreen = document.getElementById('btn-fullscreen');
    
    const unmuteOverlay = document.getElementById('unmute-overlay');
    const btnUnmute = document.getElementById('btn-unmute');

    let peerConnections = {}; 
    let viewerConnection = null;
    
    let currentRoom;
    let currentUser;
    let isHost = false;
    let localStream;
    let roomChannel;
    let isStreaming = false;
    let pendingCandidates = {}; 
    let reconnectTimeout;
    let presenceId = Math.random().toString(36).substr(2, 9); // برای جلوگیری از تداخل اسم‌ها

    // ارتقای تنظیمات ICE با پشتیبانی از TURNS (برای شبکه‌های سخت گیر)
    const config = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
            { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
            { urls: 'turns:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' }
        ],
        iceCandidatePoolSize: 10
    };

    if (btnFullscreen) {
        btnFullscreen.addEventListener('click', () => {
            const videoContainer = document.getElementById('video-container');
            if (!document.fullscreenElement) {
                if (videoContainer.requestFullscreen) videoContainer.requestFullscreen();
                btnFullscreen.innerText = "✖";
            } else {
                if (document.exitFullscreen) document.exitFullscreen();
                btnFullscreen.innerText = "⛶";
            }
        });
    }

    if (btnEmoji) {
        const emojis = ['😀', '😂', '❤️', '👍', '🔥', '😮', '😢', '🎉', '🍿', '🎬'];
        btnEmoji.addEventListener('click', () => {
            chatInput.value += emojis[Math.floor(Math.random() * emojis.length)];
            chatInput.focus();
        });
    }

    if (btnUnmute) {
        btnUnmute.addEventListener('click', () => {
            remoteVideo.muted = false;
            remoteVideo.volume = 1.0;
            unmuteOverlay.style.display = 'none';
        });
    }

    if (btnHost) btnHost.addEventListener('click', () => joinRoom(true));
    if (btnJoin) btnJoin.addEventListener('click', () => joinRoom(false));
    
    if (btnLeave) btnLeave.addEventListener('click', () => {
        Object.values(peerConnections).forEach(pc => pc.close());
        if (viewerConnection) viewerConnection.close();
        if (roomChannel && dbClient) dbClient.removeChannel(roomChannel);
        if (localStream) localStream.getTracks().forEach(track => track.stop());
        location.reload();
    });

    if (btnSend && chatInput) {
        btnSend.addEventListener('click', sendChat);
        chatInput.addEventListener('keydown', (e) => { 
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
        });
    }

    function setStatus(text, color) {
        if (statusText) {
            statusText.innerText = `● ${text}`;
            statusText.style.color = color;
        }
    }

    async function joinRoom(hostMode) {
        const usernameInput = document.getElementById('username');
        const roomInput = document.getElementById('room-id');
        if (!usernameInput || !roomInput) return;

        currentUser = usernameInput.value.trim();
        currentRoom = roomInput.value.trim();
        
        if (!currentUser || !currentRoom) return alert("لطفاً نام و کد اتاق را وارد کنید.");
        if (!dbClient) return alert("اتصال به سرور برقرار نیست.");
        
        isHost = hostMode;
        loginView.classList.remove('active');
        roomView.classList.add('active');
        document.getElementById('room-name').innerText = `اتاق: ${currentRoom}`;
        setStatus("در حال اتصال به سرور...", "#f59e0b");

        roomChannel = dbClient.channel(`room_${currentRoom}`, {
            config: { presence: { key: `${currentUser}_${presenceId}` } } // کلید یکتا
        });
        
        roomChannel
            .on('broadcast', { event: 'chat' }, (payload) => appendChat(payload.payload.user, payload.payload.text))
            .on('broadcast', { event: 'reaction' }, (payload) => showFloatingEmoji(payload.emoji))
            
            // **حل باگ مهم**: گوش دادن به رویداد شروع پخش توسط بیننده
            .on('broadcast', { event: 'stream-started' }, () => {
                if (!isHost && !remoteVideo.srcObject) {
                    console.log("Host started streaming. Sending request...");
                    roomChannel.send({ type: 'broadcast', event: 'request-stream', payload: { from: currentUser } });
                }
            })
            
            .on('broadcast', { event: 'webrtc-offer' }, async (payload) => {
                if (!isHost && payload.to === currentUser) {
                    handleViewerOffer(payload);
                }
            })
            .on('broadcast', { event: 'webrtc-answer' }, async (payload) => {
                if (isHost && payload.to === currentUser) {
                    handleHostAnswer(payload);
                }
            })
            .on('broadcast', { event: 'webrtc-ice' }, async (payload) => {
                if (payload.to === currentUser) {
                    handleIceCandidate(payload);
                }
            })
            .on('broadcast', { event: 'request-stream' }, (payload) => {
                if (isHost && isStreaming) {
                    createOfferForViewer(payload.from);
                }
            })
            .on('presence', { event: 'sync' }, () => {
                const state = roomChannel.presenceState();
                // شمارش کاربران با توجه به کلیدهای یکتا
                const userCount = Object.keys(state).length;
                onlineUsersText.innerText = `👥 ${userCount} نفر آنلاین`;
            })
            .subscribe(async (status, err) => {
                console.log("Realtime Status:", status, err);
                if (status === 'SUBSCRIBED') {
                    await roomChannel.track({ user: currentUser, online_at: new Date().toISOString() });

                    if (isHost) {
                        document.getElementById('host-controls').style.display = 'flex';
                        setStatus("آماده پخش", "#10b981");
                        setupHost();
                    } else {
                        waitingText.style.display = 'block';
                        waitingText.innerText = "در حال اتصال به سینما...";
                        setStatus("در حال اتصال", "#f59e0b");
                        
                        // درخواست اولیه
                        roomChannel.send({ type: 'broadcast', event: 'request-stream', payload: { from: currentUser } });
                    }
                }
            });
    }

    window.sendReaction = function(emoji) {
        if (roomChannel) {
            roomChannel.send({ type: 'broadcast', event: 'reaction', payload: { emoji: emoji } });
            showFloatingEmoji(emoji);
        }
    };

    function showFloatingEmoji(emoji) {
        const emojiDiv = document.createElement('div');
        emojiDiv.className = 'floating-emoji';
        emojiDiv.innerText = emoji;
        emojiDiv.style.left = Math.random() * 80 + 10 + '%';
        document.querySelector('.video-container').appendChild(emojiDiv);
        setTimeout(() => { emojiDiv.remove(); }, 3000);
    }

    function sendChat() {
        if (!chatInput) return;
        const text = chatInput.value.trim();
        if (text && roomChannel) {
            roomChannel.send({ type: 'broadcast', event: 'chat', payload: { user: currentUser, text: text } });
            appendChat(currentUser + " (شما)", text);
            chatInput.value = '';
            chatInput.focus();
        }
    }

    // **حل مشکل امنیتی XSS**: استفاده از textContent به جای innerHTML
    function appendChat(user, text) {
        if (!chatMessages) return;
        const msgDiv = document.createElement('div');
        msgDiv.className = 'msg';
        
        const nameSpan = document.createElement('span');
        nameSpan.className = 'name';
        nameSpan.textContent = user;
        
        const textNode = document.createTextNode(text);
        
        msgDiv.appendChild(nameSpan);
        msgDiv.appendChild(textNode);
        chatMessages.appendChild(msgDiv);
        chatMessages.scrollTo({ top: chatMessages.scrollHeight, behavior: 'smooth' });
    }

    function getCinemaConstraints() {
        const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
        if (isMobile) return { width: 1280, height: 720, frameRate: 30, bitrate: 1500000 }; 
        else return { width: 1920, height: 1080, frameRate: 30, bitrate: 2500000 }; 
    }

    function setupHost() {
        document.getElementById('btn-select-video').addEventListener('click', () => videoFileInput.click());
        
        videoFileInput.addEventListener('change', () => {
            const file = videoFileInput.files[0];
            if (file) {
                Object.values(peerConnections).forEach(pc => pc.close());
                peerConnections = {};

                if (localStream) localStream.getTracks().forEach(track => track.stop());
                isStreaming = false;

                localVideo.src = '';
                localVideo.load();
                localVideo.src = URL.createObjectURL(file);
                localVideo.volume = 0.3; 
                localVideo.style.display = 'block';
                remoteVideo.style.display = 'none';
                waitingText.style.display = 'none';
                unmuteOverlay.style.display = 'none';
                
                btnStartStream.disabled = false;
                btnStartStream.innerText = `🚀 شروع پخش`;
            }
        });

        btnStartStream.addEventListener('click', async () => {
            try {
                btnStartStream.innerText = "⏳ در حال آماده‌سازی...";
                await localVideo.play();
                
                localStream = localVideo.captureStream();
                isStreaming = true;
                reactionBar.style.display = 'flex';
                setStatus("در حال پخش", "#10b981");
                btnStartStream.innerText = `🟢 در حال پخش`;
                btnStartStream.disabled = true;
                
                // **اطلاع دادن به همه که استریم شروع شد**
                roomChannel.send({ type: 'broadcast', event: 'stream-started', payload: {} });

            } catch (err) {
                alert("خطا در شروع پخش: " + err.message);
                btnStartStream.innerText = "🚀 شروع پخش";
            }
        });
    }

    async function createOfferForViewer(viewerId) {
        if (peerConnections[viewerId]) {
            peerConnections[viewerId].close();
        }

        const pc = new RTCPeerConnection(config);
        peerConnections[viewerId] = pc;
        pendingCandidates[viewerId] = [];

        localStream.getTracks().forEach(track => {
            const sender = pc.addTrack(track, localStream);
            if (track.kind === 'video') {
                const params = sender.getParameters();
                if (!params.encodings) params.encodings = [{}];
                
                // **بهینه‌سازی رزولوشن و بیت‌ریت**
                params.encodings[0].maxBitrate = getCinemaConstraints().bitrate;
                params.encodings[0].scaleResolutionDownBy = 1.0; 
                params.degradationPreference = 'maintain-framerate';
                
                sender.setParameters(params).catch(e => console.warn(e));
            }
        });

        // **مدیریت وضعیت اتصال (Reconnect)**
        pc.onconnectionstatechange = () => {
            if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
                console.warn(`Connection to ${viewerId} lost. Restarting ICE...`);
                pc.restartIce();
            }
        };

        pc.onicecandidate = event => {
            if (event.candidate) {
                roomChannel.send({ type: 'broadcast', event: 'webrtc-ice', payload: { candidate: event.candidate, from: currentUser, to: viewerId } });
            }
        };

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        roomChannel.send({ type: 'broadcast', event: 'webrtc-offer', payload: { sdp: offer, from: currentUser, to: viewerId } });
    }

    async function handleHostAnswer(payload) {
        const viewerId = payload.from;
        const pc = peerConnections[viewerId];
        
        if (pc && pc.signalingState === 'have-local-offer') {
            try {
                await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
                while (pendingCandidates[viewerId] && pendingCandidates[viewerId].length > 0) {
                    const candidate = pendingCandidates[viewerId].shift();
                    await pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(e => console.error(e));
                }
            } catch (err) { console.error("Error handling host answer:", err); }
        }
    }

    async function handleViewerOffer(payload) {
        setStatus("دریافت سیگنال از میزبان", "#f59e0b");
        
        if (viewerConnection) viewerConnection.close();
        if (remoteVideo.srcObject) remoteVideo.srcObject = null;

        viewerConnection = new RTCPeerConnection(config);
        pendingCandidates['viewer'] = [];

        viewerConnection.onconnectionstatechange = () => {
            if (viewerConnection.connectionState === 'failed' || viewerConnection.connectionState === 'disconnected') {
                setStatus("بازیابی ارتباط...", "#ef4444");
                roomChannel.send({ type: 'broadcast', event: 'request-stream', payload: { from: currentUser } });
            }
        };

        viewerConnection.onicecandidate = event => {
            if (event.candidate) {
                roomChannel.send({ type: 'broadcast', event: 'webrtc-ice', payload: { candidate: event.candidate, from: currentUser, to: payload.from } });
            }
        };

        viewerConnection.ontrack = event => {
            if (remoteVideo.srcObject !== event.streams[0]) {
                remoteVideo.srcObject = event.streams[0];
            }
            remoteVideo.style.display = 'block'; 
            localVideo.style.display = 'none';
            waitingText.style.display = 'none';
            setStatus("در حال پخش", "#10b981");
            
            remoteVideo.muted = true;
            remoteVideo.play().catch(e => {
                if (e.name !== 'AbortError') unmuteOverlay.style.display = 'flex';
            });
            
            setTimeout(() => {
                if (remoteVideo.readyState >= 2) unmuteOverlay.style.display = 'flex';
            }, 1000);
        };

        try {
            await viewerConnection.setRemoteDescription(new RTCSessionDescription(payload.sdp));
            while (pendingCandidates['viewer'].length > 0) {
                const candidate = pendingCandidates['viewer'].shift();
                await viewerConnection.addIceCandidate(new RTCIceCandidate(candidate)).catch(e => console.error(e));
            }

            const answer = await viewerConnection.createAnswer();
            await viewerConnection.setLocalDescription(answer);
            roomChannel.send({ type: 'broadcast', event: 'webrtc-answer', payload: { sdp: answer, from: currentUser, to: payload.from } });
        } catch (err) { console.error("Error handling viewer offer:", err); }
    }

    async function handleIceCandidate(payload) {
        if (payload.candidate) {
            if (isHost) {
                const viewerId = payload.from;
                const pc = peerConnections[viewerId];
                if (pc && pc.remoteDescription) {
                    await pc.addIceCandidate(new RTCIceCandidate(payload.candidate)).catch(e => console.error(e));
                } else {
                    if (pendingCandidates[viewerId]) pendingCandidates[viewerId].push(payload.candidate);
                }
            } else {
                if (viewerConnection && viewerConnection.remoteDescription) {
                    await viewerConnection.addIceCandidate(new RTCIceCandidate(payload.candidate)).catch(e => console.error(e));
                } else {
                    if (pendingCandidates['viewer']) pendingCandidates['viewer'].push(payload.candidate);
                }
            }
        }
    }
});
