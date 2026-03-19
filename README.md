# 🎙 Voice Agent — Real-Time AI Voice Assistant

A production-grade, real-time voice agent pipeline built on Node.js, capable of natural conversations through both a **web browser** and **SIP phone calls** (MicroSIP).

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        INPUT SOURCES                            │
│                                                                 │
│   Browser (WebRTC mic)          MicroSIP / SIP Phone            │
│         │                              │                        │
│   Silero VAD (ONNX)            drachtio SIP Server              │
│   (local speech detection)     (SIP/RTP bridge)                 │
└──────────────┬───────────────────────┬──────────────────────────┘
               │                       │
               └───────────┬───────────┘
                           │  PCM16 16kHz audio
                           ▼
              ┌────────────────────────┐
              │    Deepgram nova-3     │  Speech-to-Text
              │    (pt-BR / en-US)     │  (cloud STT)
              └────────────┬───────────┘
                           │  transcript
                           ▼
              ┌────────────────────────┐
              │  Inception mercury-2   │  Language Model
              │  (streaming tokens)    │  (cloud LLM)
              └────────────┬───────────┘
                           │  text chunks
                           ▼
              ┌────────────────────────┐
              │    Rime TTS /ws3       │  Text-to-Speech
              │    (arcana model)      │  (cloud TTS)
              └────────────┬───────────┘
                           │  MP3 chunks + word timestamps
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                       OUTPUT                                    │
│                                                                 │
│   Browser → Web Audio API       MicroSIP ← RTP μ-law 8kHz       │
│   (real-time playback)          (ffmpeg MP3→PCM→μ-law)          │
└─────────────────────────────────────────────────────────────────┘
```

---

## Features

### Voice Pipeline
- **Real-time STT** — Deepgram nova-3 with Portuguese (pt-BR) and English support
- **Streaming LLM** — Inception Labs mercury-2 with instant reasoning
- **Neural TTS** — Rime AI /ws3 WebSocket with Arcana voice model
- **Word-level timestamps** — synchronized word highlighting during playback

### Production Patterns
- **Barge-in** — interrupt the agent mid-sentence by speaking
- **Silero VAD** — local ONNX model detects speech frames (30ms precision), prevents sending silence to Deepgram
- **Message queue** — prevents concurrent LLM calls
- **Rate limiting** — configurable requests per minute per session
- **Timeout + AbortController** — 15s LLM timeout with graceful cancellation
- **Exponential backoff reconnect** — automatic WebSocket reconnection (500ms → 15s)
- **Persistent chat history** — localStorage across browser sessions
- **Structured JSON logs** — with per-session IDs and latency metrics

### SIP Integration
- **drachtio** — lightweight SIP server (no FreeSWITCH required for local testing)
- **RTP bridge** — μ-law G.711 ↔ PCM16 16kHz codec conversion
- **RTP pacing** — 20ms packet intervals matching G.711 real-time requirements
- **VAD by RMS energy** — silence detection on the SIP RTP stream
- **Proper dialog tracking** — BYE returns 200 OK via `srf.createUAS()`

---

## Project Structure

```
voice-agent-docker/
├── docker-compose.yml          # Full stack orchestration
├── .env.example                # Environment variables template
├── prepare.sh                  # Copies agent source files into Docker context
│
├── agent/                      # Voice Agent container (STT → LLM → TTS)
│   ├── Dockerfile
│   ├── server.js               # Main WebSocket server
│   ├── index.html              # Web frontend (VAD + chat UI)
│   ├── setup-vad.js            # Copies Silero ONNX files to /public
│   └── package.json
│
├── drachtio/                   # SIP Server container
│   ├── Dockerfile
│   └── drachtio.conf.xml       # (legacy — now configured via CLI flags)
│
└── sip/                        # SIP Bridge container
    ├── Dockerfile
    ├── sip-server.js           # drachtio-srf + RTP ↔ WebSocket bridge
    └── package.json
```

---

## Prerequisites

- Docker & Docker Compose
- API keys for:
  - [Deepgram](https://deepgram.com) — STT
  - [Inception Labs](https://inceptionlabs.ai) — LLM
  - [Rime AI](https://rime.ai) — TTS
- MicroSIP installed (for SIP phone calls)

---

## Quick Start

### 1. Prepare files

```bash
chmod +x prepare.sh
./prepare.sh /path/to/app-node-chat-voz
```

### 2. Configure environment

```bash
cp .env.example .env
nano .env
```

```env
DEEPGRAM_KEY=your_deepgram_key
INCEPTION_KEY=your_inception_key
RIME_KEY=your_rime_key

# Your machine's local IP (run: hostname -I | awk '{print $1}')
HOST_IP=192.168.1.100

AGENT_SPEAKER=astra
AGENT_LANG=por
AGENT_MODEL=arcana
RATE_LIMIT=20
```

### 3. Build and start

```bash
docker-compose build
docker-compose up
```

### 4. Access the web interface

```
http://localhost:3000
```

---

## MicroSIP Configuration (SIP Phone)

1. Open MicroSIP → **Add Account**
2. Fill in:
   - **Domain:** `<your HOST_IP>` (e.g. `192.168.2.110`)
   - **Username:** `1001` (any value)
   - **Password:** `1234` (any value)
   - **Transport:** UDP
3. Click **OK** — the account should register (green indicator)
4. Dial the agent:

```
sip:agente@192.168.2.110
```

---

## Container Services

| Container | Role | Ports |
|---|---|---|
| `drachtio` | SIP server — handles INVITE / REGISTER / BYE | 5060 UDP/TCP, 9022 TCP |
| `voice-agent` | STT → LLM → TTS WebSocket pipeline | 3000 TCP |
| `sip-bridge` | RTP ↔ WebSocket codec bridge | 3001 TCP (health), 20000-20100 UDP (RTP) |

> **Why `network_mode: host`?**
> SIP embeds the IP address inside the SDP message body (not the network header). With Docker NAT, the container would advertise its internal IP (172.x.x.x), causing RTP to fail. `network_mode: host` gives containers direct access to the host network, so the real machine IP is advertised in SDP.

---

## API Keys & Services

### Deepgram STT
- Model: `nova-3`
- Languages: `pt-BR`, `en-US`, `es`, `fr`
- Features used: `smart_format`, `vad_events`, `endpointing`
- [Console](https://console.deepgram.com)

### Inception Labs LLM
- Model: `mercury-2`
- Compatible with OpenAI SDK (`baseURL: https://api.inceptionlabs.ai/v1`)
- Parameter: `reasoning_effort: instant`
- [Dashboard](https://inceptionlabs.ai)

### Rime TTS
- Endpoint: `wss://users-ws.rime.ai/ws3`
- Model: `arcana` (or `mistv2`)
- Format: `mp3` with word-level timestamps
- [Dashboard](https://app.rime.ai)

---

## Firewall Rules

If using UFW, open the required ports:

```bash
sudo ufw allow 5060/udp    # SIP
sudo ufw allow 5060/tcp    # SIP TCP
sudo ufw allow 3000/tcp    # Web interface
sudo ufw allow 20000:20100/udp  # RTP media
```

---

## Health Checks

```bash
# Container status
docker-compose ps

# Voice agent
curl http://localhost:3000/

# SIP bridge
curl http://localhost:3001/health

# Verify drachtio port
bash -c 'echo > /dev/tcp/localhost/9022' && echo "drachtio OK"

# Live logs
docker-compose logs -f
docker-compose logs -f sip
docker-compose logs -f voice-agent
```

---

## Audio Flow (SIP Call)

```
MicroSIP mic
    │ G.711 μ-law 8kHz RTP packets (160 bytes / 20ms)
    ▼
sip-bridge (port 20000-20100 UDP)
    │ ulawToPcm16() → resample8to16()
    │ PCM16 32kHz accumulated
    │ RMS energy VAD (threshold: 150, silence: 1500ms)
    ▼
vad_audio_complete → voice-agent WebSocket
    │
    ├─▶ Deepgram STT → transcript
    ├─▶ Inception LLM → response tokens
    └─▶ Rime TTS → MP3 chunks → audio_done
              │
              ▼
         ffmpeg (MP3 → PCM16 8kHz)
              │ pcm16ToUlaw()
              │ RTP pacing: 160 bytes every 20ms
              ▼
         MicroSIP speaker 🔊
```

---

## Production Migration Path

This setup uses **drachtio** as a lightweight SIP server for local testing. For production with multiple concurrent users, migrate to **DSIProuter + FreeSWITCH**:

```
Current (dev):
  MicroSIP → drachtio → sip-bridge → voice-agent

Production:
  Any SIP client → DSIProuter (routing/auth) → FreeSWITCH (media)
                                                      │
                                              mod_audio_stream WebSocket
                                                      │
                                               voice-agent (unchanged)
```

With FreeSWITCH `mod_audio_stream`, the entire `sip-server.js` is replaced — FreeSWITCH delivers audio directly via WebSocket in the same format the browser already uses. The `server.js` voice agent requires **zero changes**.

---

## Troubleshooting

### MicroSIP registers but no audio on call

1. Verify `HOST_IP` in `.env` matches your actual LAN IP:
   ```bash
   hostname -I | awk '{print $1}'
   ```
2. Check RTP ports are open:
   ```bash
   sudo ufw allow 20000:20100/udp
   ```
3. Check sip-bridge logs for `Chamada atendida`:
   ```bash
   docker-compose logs sip
   ```

### Agent doesn't respond (text transcription empty)

- Audio segment too short — speak for at least 0.5 seconds
- RMS energy threshold may need adjustment (`MIN_ENERGY` in `sip-server.js`)
- Check Deepgram key and quota

### BYE returns 404

- Ensure using the latest `sip-server.js` with `srf.createUAS()` (not `res.send(200)`)
- Rebuild the sip container: `docker-compose build sip`

### drachtio fails to start

```bash
docker-compose logs drachtio
docker-compose restart drachtio
```

### ffmpeg not found in sip container

The `sip/Dockerfile` installs ffmpeg via Alpine `apk`. If missing:
```bash
docker-compose build --no-cache sip
```

---

## Environment Variables Reference

| Variable | Default | Description |
|---|---|---|
| `DEEPGRAM_KEY` | — | Deepgram API key |
| `INCEPTION_KEY` | — | Inception Labs API key |
| `RIME_KEY` | — | Rime AI API key |
| `HOST_IP` | — | **Required** — host machine LAN IP |
| `AGENT_SPEAKER` | `astra` | Rime voice name |
| `AGENT_LANG` | `por` | Language code (`por`, `eng`, `spa`) |
| `AGENT_MODEL` | `arcana` | Rime TTS model (`arcana`, `mistv2`) |
| `RATE_LIMIT` | `20` | Max LLM requests per minute per session |
| `RTP_PORT_MIN` | `20000` | RTP port range start |
| `RTP_PORT_MAX` | `20100` | RTP port range end |
| `HTTP_PORT` | `3001` | SIP bridge health check port |

---

## License

MIT