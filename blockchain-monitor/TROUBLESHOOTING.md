# WebSocket Streaming Troubleshooting Guide

## Quick Diagnosis

### Error: "Broadcaster not found"

**Server Logs:**
```
[WebRTC Request] Broadcaster not found: 0x5368bDd0F9BC14C223a67b95874842dD77250d08
```

**What happened:**
- Viewer tried to request WebRTC offer from broadcaster
- Server couldn't find broadcaster by their Ethereum address
- Connection failed before WebRTC negotiation started

**Root Cause:**
Broadcaster forgot to register their address with the server!

**Fix:**
```javascript
// Broadcaster must send this BEFORE starting stream:
ws.send(JSON.stringify({
  type: 'register-address',
  address: '0x5368bDd0F9BC14C223a67b95874842dD77250d08'
}));
```

**Verification:**
```javascript
// Check if address is registered:
ws.send(JSON.stringify({ type: 'debug-clients' }));

// Look for your client in response:
{
  "type": "debug-clients",
  "clients": [
    {
      "id": "client-1759257267121-98mrg4cks",
      "address": "0x5368bDd0F9BC14C223a67b95874842dD77250d08", // ✅ Should be set!
      "authenticated": false,
      "joinedStreams": [],
      "isStreaming": true
    }
  ]
}
```

---

## Error: "Failed to execute 'addIceCandidate' on 'RTCPeerConnection': The remote description was null"

**What happened:**
- ICE candidates arrived before offer/answer SDP was set
- Race condition in WebRTC signaling (common over the internet with higher latency)

**Fix:**
The server buffers ICE candidates, but **you MUST also queue them client-side**. This is especially critical over the internet where network latency causes more out-of-order arrivals.

### Complete Client-Side Fix:

```javascript
class PeerConnectionManager {
  constructor() {
    this.peerConnection = null;
    this.iceCandidateQueue = [];
  }

  handleIceCandidate(data) {
    if (data.candidate) {
      // CRITICAL: Check if remote description is set
      if (!this.peerConnection.remoteDescription) {
        // Queue the candidate - DO NOT try to add it yet!
        this.iceCandidateQueue.push(data.candidate);
        console.log(`[ICE] Queued candidate (${this.iceCandidateQueue.length} total)`);
        return;
      }

      // Remote description is set, add immediately
      this.addIceCandidate(data.candidate);
    }
  }

  async handleOffer(data) {
    // Set remote description
    await this.peerConnection.setRemoteDescription(
      new RTCSessionDescription(data.offer)
    );

    // IMPORTANT: Flush queued candidates AFTER setting remote description
    await this.flushIceCandidates();

    // Then create answer
    const answer = await this.peerConnection.createAnswer();
    await this.peerConnection.setLocalDescription(answer);

    // Send answer...
  }

  async handleAnswer(data) {
    // Set remote description
    await this.peerConnection.setRemoteDescription(
      new RTCSessionDescription(data.answer)
    );

    // IMPORTANT: Flush queued candidates AFTER setting remote description
    await this.flushIceCandidates();
  }

  async addIceCandidate(candidate) {
    try {
      await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      console.log('[ICE] Added candidate successfully');
    } catch (error) {
      console.error('[ICE] Failed to add candidate:', error);
    }
  }

  async flushIceCandidates() {
    if (this.iceCandidateQueue.length > 0) {
      console.log(`[ICE] Flushing ${this.iceCandidateQueue.length} queued candidates`);

      for (const candidate of this.iceCandidateQueue) {
        await this.addIceCandidate(candidate);
      }

      // Clear the queue
      this.iceCandidateQueue = [];
    }
  }
}
```

### Why This Is Required:

1. **Server-side buffering** delays ICE candidates from being sent too early
2. **Client-side queuing** handles candidates that still arrive before `setRemoteDescription()` completes
3. **Network latency** over the internet makes timing issues more common
4. **Dual-layer buffering** (server + client) ensures 100% reliability

### Checklist:

- [ ] Check `pc.remoteDescription` before calling `addIceCandidate()`
- [ ] Queue candidates if `remoteDescription` is `null`
- [ ] Call `flushIceCandidates()` AFTER `setRemoteDescription()`
- [ ] Handle both offer and answer flows
- [ ] Use try/catch when adding candidates

---

## Error: ICE Connected But No Media (bytesReceived: 0)

**Symptoms:**
```
Active ICE pair found but connection stuck:
{
  localCandidate: 'I2s93ljb0',
  remoteCandidate: 'ItWTujsQY',
  bytesReceived: 0,      // ❌ NO DATA RECEIVED
  bytesSent: 1071        // ✅ Sending data
}
```

**What this means:**
- ✅ ICE connection successful (candidates exchanged)
- ✅ Signaling worked correctly
- ❌ **No media data is flowing** from sender to receiver

### Possible Causes & Fixes

#### 1. **Broadcaster Not Adding Tracks** (Most Common!)

The broadcaster created a peer connection but forgot to add media tracks before creating the offer.

**Check if broadcaster is adding tracks:**

```javascript
// ❌ BAD: Peer connection created but no tracks added
const pc = new RTCPeerConnection({...});
const offer = await pc.createOffer(); // No tracks = no media!

// ✅ GOOD: Add tracks BEFORE creating offer
const pc = new RTCPeerConnection({...});

// Get user media first
const localStream = await navigator.mediaDevices.getUserMedia({
  video: true,
  audio: true
});

// Add tracks to peer connection
localStream.getTracks().forEach(track => {
  pc.addTrack(track, localStream);
  console.log('✅ Added track:', track.kind, track.id);
});

// Verify tracks were added
console.log('Number of senders:', pc.getSenders().length); // Should be 2

// THEN create offer
const offer = await pc.createOffer();
```

**Verification on broadcaster side:**

```javascript
// Before creating offer, run this check:
const senders = peerConnection.getSenders();
console.log('=== BROADCASTER TRACK CHECK ===');
console.log('Number of tracks being sent:', senders.length); // Should be 2 (video + audio)

senders.forEach((sender, i) => {
  if (sender.track) {
    console.log(`Track ${i}:`, {
      kind: sender.track.kind,
      enabled: sender.track.enabled,
      readyState: sender.track.readyState, // Should be "live"
      muted: sender.track.muted
    });
  } else {
    console.error(`❌ Sender ${i} has no track!`);
  }
});

// If this shows 0 senders or senders without tracks, that's your problem!
```

#### 2. **Media Stream Not Initialized Properly**

The `getUserMedia()` call might have failed or returned an empty stream.

**Verify stream before adding to peer connection:**

```javascript
const stream = await navigator.mediaDevices.getUserMedia({
  video: true,
  audio: true
}).catch(err => {
  console.error('❌ getUserMedia failed:', err);
  throw err;
});

console.log('Stream tracks:', stream.getTracks());
// Should show: [MediaStreamTrack (video), MediaStreamTrack (audio)]

stream.getTracks().forEach(track => {
  console.log(`${track.kind} track:`, {
    id: track.id,
    label: track.label,
    enabled: track.enabled,
    muted: track.muted,
    readyState: track.readyState // Must be "live"
  });

  if (track.readyState !== 'live') {
    console.error(`❌ Track ${track.kind} is not live!`);
  }
});
```

**Common issues:**
- `track.readyState === 'ended'` → Track was stopped before being added
- `track.enabled === false` → Track is disabled
- `stream.getTracks().length === 0` → getUserMedia failed silently
- Browser didn't grant camera/mic permissions

#### 3. **Viewer Not Handling `ontrack` Event**

The viewer's peer connection isn't listening for incoming tracks.

```javascript
// ❌ BAD: No ontrack handler - video will never display!
const pc = new RTCPeerConnection({...});
await pc.setRemoteDescription(offer);
// ...

// ✅ GOOD: Set ontrack handler BEFORE receiving offer
const pc = new RTCPeerConnection({...});

pc.ontrack = (event) => {
  console.log('✅ Received track:', event.track.kind);
  console.log('Stream ID:', event.streams[0].id);

  const videoElement = document.getElementById('remoteVideo');

  // Set srcObject only once (first track)
  if (!videoElement.srcObject) {
    videoElement.srcObject = event.streams[0];
    console.log('Set video srcObject');
  }

  // Verify setup
  console.log('Video element state:', {
    hasSrcObject: !!videoElement.srcObject,
    paused: videoElement.paused,
    muted: videoElement.muted,
    readyState: videoElement.readyState
  });
};

// Also listen for track ended events
pc.addEventListener('track', (event) => {
  event.track.addEventListener('ended', () => {
    console.warn('Track ended:', event.track.kind);
  });

  event.track.addEventListener('mute', () => {
    console.warn('Track muted:', event.track.kind);
  });
});
```

#### 4. **Firewall Blocking Media (But Not Signaling)**

Sometimes firewalls allow signaling but block media packets.

**Check ICE candidate types:**

```javascript
peerConnection.onicecandidate = (event) => {
  if (event.candidate) {
    const type = event.candidate.type;
    const candidateStr = event.candidate.candidate;

    console.log('ICE candidate type:', type);
    console.log('Full candidate:', candidateStr);

    // Check for "typ" in candidate string
    if (candidateStr.includes('typ host')) {
      console.log('→ Local network address (may not work over internet)');
    } else if (candidateStr.includes('typ srflx')) {
      console.log('→ STUN server reflexive (should work through NAT) ✅');
    } else if (candidateStr.includes('typ relay')) {
      console.log('→ TURN relay (works through firewalls) ✅');
    }
  }
};
```

**If you only see `typ host` candidates:**

The browser couldn't reach STUN servers or create NAT bindings. Add a TURN server:

```javascript
const pc = new RTCPeerConnection({
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    {
      // Free TURN server for testing (replace in production!)
      urls: 'turn:openrelay.metered.ca:80',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    }
  ]
});
```

#### 5. **SDP Doesn't Include Media**

Check if the offer/answer SDP actually includes media descriptions.

```javascript
// After creating offer:
const offer = await pc.createOffer();
console.log('=== OFFER SDP CHECK ===');
console.log(offer.sdp);

// Look for these lines in the SDP:
// m=video ... (video media line - MUST be present)
// m=audio ... (audio media line - MUST be present)
// a=sendrecv (bidirectional) or a=sendonly (broadcaster)

// Count media lines
const videoLines = (offer.sdp.match(/m=video/g) || []).length;
const audioLines = (offer.sdp.match(/m=audio/g) || []).length;

console.log(`Video media lines: ${videoLines}`); // Should be >= 1
console.log(`Audio media lines: ${audioLines}`); // Should be >= 1

// Check direction
if (offer.sdp.includes('a=inactive')) {
  console.error('❌ SDP shows inactive media!');
}
if (!offer.sdp.includes('a=sendrecv') && !offer.sdp.includes('a=sendonly')) {
  console.error('❌ SDP missing send direction!');
}
```

**If SDP is missing `m=video` or `m=audio` lines:**
→ Tracks weren't added to peer connection before calling `createOffer()`

**Solution:** Add tracks, then call `createOffer()` again.

#### 6. **Video Element Not Configured Properly** (Viewer)

The HTML video element might not be set up for autoplay.

```javascript
const videoElement = document.getElementById('remoteVideo');

// Check element exists
if (!videoElement) {
  console.error('❌ Video element #remoteVideo not found in DOM!');
} else {
  // Set required attributes
  videoElement.autoplay = true;
  videoElement.playsInline = true; // Critical for iOS!
  videoElement.muted = true; // Often required for autoplay policy

  // Listen for events
  videoElement.onloadedmetadata = () => {
    console.log('✅ Video metadata loaded');
    console.log('Video dimensions:', videoElement.videoWidth, 'x', videoElement.videoHeight);

    videoElement.play().catch(err => {
      console.error('❌ Play failed:', err);
      console.log('Try muting the video or requiring user interaction');
    });
  };

  videoElement.onplay = () => {
    console.log('✅ Video is playing!');
  };

  videoElement.onpause = () => {
    console.warn('⚠️ Video paused');
  };

  videoElement.onerror = (e) => {
    console.error('❌ Video element error:', e);
  };
}
```

### Complete Debug Checklist

**Run on BROADCASTER:**

```javascript
console.log('=== BROADCASTER DEBUG ===');

// 1. Check local stream
const stream = localStream; // Your media stream
console.log('1. Local stream:', {
  exists: !!stream,
  tracks: stream?.getTracks().length,
  trackDetails: stream?.getTracks().map(t => ({
    kind: t.kind,
    enabled: t.enabled,
    readyState: t.readyState
  }))
});

// 2. Check peer connection senders
console.log('2. Peer connection senders:', {
  count: peerConnection.getSenders().length,
  details: peerConnection.getSenders().map(s => ({
    hasTrack: !!s.track,
    kind: s.track?.kind,
    enabled: s.track?.enabled,
    readyState: s.track?.readyState
  }))
});

// 3. Check connection states
console.log('3. Connection states:', {
  connection: peerConnection.connectionState,
  ice: peerConnection.iceConnectionState,
  signaling: peerConnection.signalingState
});

// 4. Check if offer was created with media
console.log('4. Last offer included media:', {
  hasVideo: peerConnection.localDescription?.sdp.includes('m=video'),
  hasAudio: peerConnection.localDescription?.sdp.includes('m=audio'),
  direction: peerConnection.localDescription?.sdp.match(/a=(sendrecv|sendonly|recvonly|inactive)/)?.[1]
});
```

**Run on VIEWER:**

```javascript
console.log('=== VIEWER DEBUG ===');

// 1. Check peer connection receivers
console.log('1. Peer connection receivers:', {
  count: peerConnection.getReceivers().length,
  details: peerConnection.getReceivers().map(r => ({
    hasTrack: !!r.track,
    kind: r.track?.kind,
    enabled: r.track?.enabled,
    readyState: r.track?.readyState
  }))
});

// 2. Check connection states
console.log('2. Connection states:', {
  connection: peerConnection.connectionState,
  ice: peerConnection.iceConnectionState,
  signaling: peerConnection.signalingState
});

// 3. Check video element
const video = document.getElementById('remoteVideo');
console.log('3. Video element:', {
  exists: !!video,
  hasSrcObject: !!video?.srcObject,
  trackCount: video?.srcObject?.getTracks().length,
  paused: video?.paused,
  muted: video?.muted,
  autoplay: video?.autoplay,
  readyState: video?.readyState,
  videoWidth: video?.videoWidth,
  videoHeight: video?.videoHeight
});

// 4. Check remote description
console.log('4. Remote description:', {
  hasVideo: peerConnection.remoteDescription?.sdp.includes('m=video'),
  hasAudio: peerConnection.remoteDescription?.sdp.includes('m=audio'),
  direction: peerConnection.remoteDescription?.sdp.match(/a=(sendrecv|sendonly|recvonly|inactive)/)?.[1]
});
```

### Quick Fix Summary

**If bytesReceived = 0:**

1. **Broadcaster must:**
   - ✅ Call `getUserMedia()` successfully
   - ✅ Add tracks with `pc.addTrack()` BEFORE `createOffer()`
   - ✅ Verify `getSenders().length === 2`
   - ✅ Check SDP includes `m=video` and `m=audio`

2. **Viewer must:**
   - ✅ Set `pc.ontrack` handler BEFORE setting remote description
   - ✅ Set video element attributes: `autoplay`, `playsInline`, `muted`
   - ✅ Verify `getReceivers().length === 2`
   - ✅ Check video element `srcObject` is set

3. **Both must:**
   - ✅ Have `connectionState === 'connected'`
   - ✅ Have ICE candidates with `typ srflx` or `typ relay`
   - ✅ Check browser console for media permission errors
   - ✅ Use TURN server if on restrictive network

---

## WebRTC Connection States

Monitor connection states to diagnose issues:

```javascript
peerConnection.onconnectionstatechange = () => {
  console.log('Connection state:', peerConnection.connectionState);

  switch(peerConnection.connectionState) {
    case 'new':
      // Connection is being created
      break;
    case 'connecting':
      // ICE candidates are being exchanged
      break;
    case 'connected':
      // ✅ Connection successful!
      break;
    case 'disconnected':
      // Temporary network issue
      // Usually recovers automatically
      break;
    case 'failed':
      // ❌ Connection failed - need to restart
      handleConnectionFailure();
      break;
    case 'closed':
      // Connection closed normally
      break;
  }
};

peerConnection.oniceconnectionstatechange = () => {
  console.log('ICE state:', peerConnection.iceConnectionState);
};

peerConnection.onicegatheringstatechange = () => {
  console.log('ICE gathering:', peerConnection.iceGatheringState);
};
```

---

## Common Issues Checklist

### Stream Won't Start

- [ ] Broadcaster registered address with `register-address`?
- [ ] Camera/microphone permissions granted?
- [ ] `getUserMedia` succeeded without errors?
- [ ] WebSocket connection is open (`ws.readyState === 1`)?
- [ ] `stream-start` message sent successfully?

### Viewer Can't Connect

- [ ] Viewer sent `webrtc-request` to correct address?
- [ ] Broadcaster is online and registered?
- [ ] Check server logs for "Broadcaster not found"?
- [ ] Firewall/NAT not blocking WebRTC traffic?
- [ ] STUN servers reachable?

### Video Plays But No Audio / Audio But No Video

```javascript
// Check what tracks are being sent:
peerConnection.getSenders().forEach(sender => {
  console.log('Sending track:', sender.track?.kind);
});

// Check what tracks are being received:
peerConnection.getReceivers().forEach(receiver => {
  console.log('Receiving track:', receiver.track?.kind);
});
```

### Connection Drops After Few Seconds

**Possible causes:**
1. **No ICE candidates:** Check firewall/NAT configuration
2. **Need TURN server:** Direct connection not possible
3. **Network issues:** Use connection state monitoring

**Solution: Add TURN Server**
```javascript
const peerConnection = new RTCPeerConnection({
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    {
      urls: 'turn:your-turn-server.com:3478',
      username: 'user',
      credential: 'pass'
    }
  ]
});
```

---

## Debug Commands

### 1. Check Connected Clients

```javascript
ws.send(JSON.stringify({ type: 'debug-clients' }));
```

**Response shows:**
- All connected clients
- Their addresses (if registered)
- Authentication status
- Active streams

### 2. Test Message Routing

```javascript
ws.send(JSON.stringify({
  type: 'debug-route',
  to: '0xTargetAddress',
  message: 'Test'
}));
```

**Success:**
```json
{
  "type": "debug-route-ack",
  "success": true,
  "sentTo": "0xTargetAddress"
}
```

**Failure:**
```json
{
  "type": "debug-route-ack",
  "success": false,
  "error": "Target not found",
  "availableClients": ["0xAddress1", "0xAddress2"]
}
```

### 3. Test Broadcast

```javascript
ws.send(JSON.stringify({
  type: 'broadcast-test',
  message: 'Hello'
}));
```

All clients should receive the message.

### 4. Echo Test

```javascript
ws.send(JSON.stringify({
  type: 'echo',
  testData: { any: 'data' }
}));
```

Server echoes back the exact message.

---

## Server-Side Debugging

### Enable Debug Mode

Start server with debug flag:
```bash
node src/index.js --debug
```

### Check Server Logs

Look for these patterns:

**Successful connection:**
```
New WebSocket connection from ::1 (1 total, 1 from this IP)
```

**Address registration:**
```
Client client-1759257267121-98mrg4cks registered with address 0x5368bDd0F9BC14C223a67b95874842dD77250d08
```

**Stream started:**
```
[Stream Start] {
  streamId: 'stream-1759257342997-s0obse',
  title: 'xxx',
  streamer: '0x5368bDd0F9BC14C223a67b95874842dD77250d08',
  clientId: 'client-1759257267121-98mrg4cks',
  clientAddress: null  // ❌ Should be set if register-address was sent!
}
```

**WebRTC signaling:**
```
[WebRTC Request] {
  from: 'client-1759257218056-p9g3qykgl',
  to: '0x5368bDd0F9BC14C223a67b95874842dD77250d08',
  action: 'request-offer',
  streamId: 'stream-1759257342997-s0obse'
}
[WebRTC Request] Forwarding to broadcaster: {...}  // ✅ Success
```

**ICE candidate buffering:**
```
[ICE Buffer] Buffered candidate for client-xyz:client-abc:stream-123, total: 3
[ICE Buffer] Flushing 3 buffered candidates for client-xyz:client-abc:stream-123
```

---

## Network Diagnostics

### Test STUN Server

```javascript
const pc = new RTCPeerConnection({
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
});

pc.createDataChannel('test');

pc.onicecandidate = (event) => {
  if (event.candidate) {
    console.log('ICE candidate:', event.candidate.candidate);
    // Look for "srflx" (reflexive) candidates - indicates STUN is working
    // Look for "relay" candidates - indicates TURN is working
  }
};

const offer = await pc.createOffer();
await pc.setLocalDescription(offer);
```

**Good output:**
```
ICE candidate: candidate:... typ srflx ...  // ✅ STUN working
ICE candidate: candidate:... typ relay ...  // ✅ TURN working (if configured)
```

**Bad output (only host candidates):**
```
ICE candidate: candidate:... typ host ...   // ❌ Only local addresses
```

If only host candidates appear:
- Check firewall settings
- Verify STUN server is reachable
- Consider adding TURN server

---

## Performance Issues

### High Latency

1. **Check ICE connection type:**
```javascript
const stats = await peerConnection.getStats();
stats.forEach(report => {
  if (report.type === 'candidate-pair' && report.state === 'succeeded') {
    console.log('Connection type:', report.currentRoundTripTime);
  }
});
```

2. **Monitor bitrate:**
```javascript
setInterval(async () => {
  const stats = await peerConnection.getStats();
  stats.forEach(report => {
    if (report.type === 'inbound-rtp' && report.kind === 'video') {
      console.log('Video bitrate:', report.bytesReceived);
    }
  });
}, 1000);
```

### Choppy Video

1. **Reduce video quality:**
```javascript
const stream = await navigator.mediaDevices.getUserMedia({
  video: {
    width: { ideal: 640 },
    height: { ideal: 480 },
    frameRate: { ideal: 24 }
  },
  audio: true
});
```

2. **Enable adaptive bitrate:**
```javascript
const sender = peerConnection.getSenders().find(s => s.track?.kind === 'video');
const params = sender.getParameters();

if (!params.encodings) {
  params.encodings = [{}];
}

params.encodings[0].maxBitrate = 500000; // 500 kbps
await sender.setParameters(params);
```

---

## Browser Compatibility

### Check WebRTC Support

```javascript
function checkWebRTCSupport() {
  const checks = {
    getUserMedia: !!(navigator.mediaDevices?.getUserMedia),
    RTCPeerConnection: !!window.RTCPeerConnection,
    WebSocket: !!window.WebSocket
  };

  console.log('WebRTC support:', checks);
  return Object.values(checks).every(Boolean);
}
```

### Known Issues

**Safari:**
- Requires `https://` for getUserMedia (even on localhost)
- May need different STUN/TURN configuration

**Firefox:**
- Stricter CORS policies for media streams
- Different ICE gathering behavior

**Chrome:**
- Best WebRTC support
- Most permissive for development

---

## Getting Help

If you're still stuck:

1. **Check server logs** in `blockchain-monitor/server.log`
2. **Enable debug mode** with `--debug` flag
3. **Use browser DevTools** → Network tab → WS filter
4. **Capture WebRTC stats** with `chrome://webrtc-internals/`
5. **Test with debug commands** listed above

**Useful Browser URLs:**
- Chrome: `chrome://webrtc-internals/`
- Firefox: `about:webrtc`
- Edge: `edge://webrtc-internals/`

These pages show detailed WebRTC connection stats, ICE candidates, and error logs.
