/**
 * sip-server.js — Docker version
 * Ponte: MicroSIP ──SIP/RTP──▶ drachtio ──▶ voice-agent
 */
require('dotenv').config();
const Srf   = require('drachtio-srf');
const http  = require('http');
const { WebSocket } = require('ws');
const dgram = require('dgram');
const { spawn } = require('child_process');
const os    = require('os');

// ─── Config ───────────────────────────────────────────────────────────────────
const DRACHTIO_HOST   = process.env.DRACHTIO_HOST   || 'localhost';
const DRACHTIO_PORT   = parseInt(process.env.DRACHTIO_PORT   || '9022');
const DRACHTIO_SECRET = process.env.DRACHTIO_SECRET || 'CaminhoDrachtio2024';
const AGENT_WS_URL    = process.env.AGENT_WS_URL    || 'ws://localhost:3000/agent';
const AGENT_SPEAKER   = process.env.AGENT_SPEAKER   || 'astra';
const AGENT_LANG      = process.env.AGENT_LANG      || 'por';
const AGENT_MODEL     = process.env.AGENT_MODEL     || 'arcana';
const HTTP_PORT       = parseInt(process.env.HTTP_PORT || '3001');
const RTP_HOST        = process.env.RTP_HOST || getLocalIp();
const RTP_PORT_MIN    = parseInt(process.env.RTP_PORT_MIN || '20000');
const RTP_PORT_MAX    = parseInt(process.env.RTP_PORT_MAX || '20100');

let nextRtpPort = RTP_PORT_MIN;
function allocRtpPort() {
  const p = nextRtpPort;
  nextRtpPort = nextRtpPort >= RTP_PORT_MAX ? RTP_PORT_MIN : nextRtpPort + 2;
  return p;
}

// ─── Logger ───────────────────────────────────────────────────────────────────
let callCounter = 0;
function logger(callId) {
  const fmt = (level, msg, meta = {}) =>
    console.log(JSON.stringify({ ts: new Date().toISOString(), level, call: callId, msg, ...meta }));
  return { info:(m,x)=>fmt('INFO',m,x), warn:(m,x)=>fmt('WARN',m,x), error:(m,x)=>fmt('ERROR',m,x) };
}

// ─── Codec μ-law ↔ PCM16 ─────────────────────────────────────────────────────
const ULAW_TO_PCM = (() => {
  const t = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    let u = ~i & 0xFF;
    const sign = u & 0x80, exp = (u >> 4) & 0x07, mant = u & 0x0F;
    let val = ((mant << 3) + 132) << exp; val -= 132;
    t[i] = sign ? -val : val;
  }
  return t;
})();

function ulawToPcm16(buf) {
  const out = Buffer.allocUnsafe(buf.length * 2);
  for (let i = 0; i < buf.length; i++) out.writeInt16LE(ULAW_TO_PCM[buf[i]], i * 2);
  return out;
}

function pcm16ToUlaw(buf) {
  const out = Buffer.allocUnsafe(buf.length / 2);
  for (let i = 0; i < out.length; i++) {
    let s = buf.readInt16LE(i * 2);
    const sign = (s >> 8) & 0x80;
    if (sign) s = -s;
    if (s > 32635) s = 32635;
    s += 132;
    let exp = 7;
    for (let j = 0, mask = 0x4000; j < 8; j++, mask >>= 1) { if (s & mask) { exp = 7-j; break; } }
    const mant = (s >> (exp + 3)) & 0x0F;
    out[i] = ~(sign | (exp << 4) | mant) & 0xFF;
  }
  return out;
}

function resample8to16(buf) {
  const out = Buffer.allocUnsafe(buf.length * 2);
  for (let i = 0; i < buf.length / 2; i++) {
    const s = buf.readInt16LE(i * 2);
    out.writeInt16LE(s, i * 4); out.writeInt16LE(s, i * 4 + 2);
  }
  return out;
}

function mp3ToPcm16(mp3Buf, sampleRate = 8000) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-i','pipe:0','-f','s16le','-ar',String(sampleRate),'-ac','1','pipe:1'],
      { stdio: ['pipe','pipe','ignore'] });
    const chunks = [];
    ff.stdout.on('data', d => chunks.push(d));
    ff.stdout.on('end', () => resolve(Buffer.concat(chunks)));
    ff.on('error', reject);
    ff.stdin.write(mp3Buf); ff.stdin.end();
  });
}

function getLocalIp() {
  const nets = os.networkInterfaces();
  for (const iface of Object.values(nets))
    for (const net of iface)
      if (net.family === 'IPv4' && !net.internal) return net.address;
  return '127.0.0.1';
}

// ─── Pipeline de áudio ────────────────────────────────────────────────────────
async function startAudioPipeline(remoteIp, remotePort, rtpSocket, log) {
  const agentUrl = `${AGENT_WS_URL}?speaker=${AGENT_SPEAKER}&lang=${AGENT_LANG}&model=${AGENT_MODEL}`;
  const agentWs  = new WebSocket(agentUrl);
  let agentReady = false;
  const msgQueue = [];
  let mp3Acc = Buffer.alloc(0);
  let rtpSeq = 0, rtpTs = 0;
  const SSRC = Math.floor(Math.random() * 0xFFFFFFFF);

  // RTP pacing — 20ms entre pacotes
  function sendRtp(ulaw) {
    const PACKET = 160, INTERVAL = 20;
    let offset = 0;
    function sendNext() {
      if (offset + PACKET > ulaw.length) return;
      const payload = ulaw.slice(offset, offset + PACKET);
      const hdr = Buffer.allocUnsafe(12);
      hdr[0] = 0x80; hdr[1] = 0x00;
      hdr.writeUInt16BE(rtpSeq++ & 0xFFFF, 2);
      hdr.writeUInt32BE(rtpTs, 4);
      hdr.writeUInt32BE(SSRC, 8);
      rtpTs += PACKET;
      rtpSocket.send(Buffer.concat([hdr, payload]), remotePort, remoteIp);
      offset += PACKET;
      if (offset + PACKET <= ulaw.length) setTimeout(sendNext, INTERVAL);
    }
    sendNext();
  }

  // VAD por energia RMS
  let pcmAcc = Buffer.alloc(0), silenceTimer = null, speechStarted = false;
  const SILENCE_MS = 1500, MIN_ENERGY = 150, MIN_MS = 400;

  function rms(buf) {
    let sum = 0;
    for (let i = 0; i < buf.length; i += 2) { const s = buf.readInt16LE(i); sum += s*s; }
    return Math.sqrt(sum / (buf.length / 2));
  }

  function flush() {
    if (pcmAcc.length < 16000 * 2 * MIN_MS / 1000) { pcmAcc = Buffer.alloc(0); return; }
    const buf = pcmAcc; pcmAcc = Buffer.alloc(0); speechStarted = false;
    const durationMs = Math.round(buf.length / 2 / 16);
    log.info('Enviando fala ao agente', { durationMs, bytes: buf.length });
    const msg = JSON.stringify({ type: 'vad_audio_complete', data: buf.toString('base64'), durationMs });
    if (agentReady && agentWs.readyState === WebSocket.OPEN) agentWs.send(msg);
    else msgQueue.push(msg);
  }

  agentWs.on('open', () => {
    agentReady = true; log.info('Agente WS conectado');
    agentWs.send(JSON.stringify({ type: 'start_listening' }));
    for (const m of msgQueue) agentWs.send(m);
    msgQueue.length = 0;
  });

  agentWs.on('message', async (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'audio_chunk' && msg.data)
      mp3Acc = Buffer.concat([mp3Acc, Buffer.from(msg.data, 'base64')]);
    if (msg.type === 'audio_done' && mp3Acc.length > 0) {
      try {
        log.info('Convertendo MP3→RTP', { bytes: mp3Acc.length });
        const pcm8k = await mp3ToPcm16(mp3Acc, 8000);
        sendRtp(pcm16ToUlaw(pcm8k));
        log.info('TTS→RTP enviado', { samples: pcm8k.length / 2 });
      } catch(e) { log.error('Erro MP3→RTP', { error: e.message }); }
      mp3Acc = Buffer.alloc(0);
    }
  });

  agentWs.on('error', e => log.error('Agente WS erro', { error: e.message }));

  rtpSocket.on('message', (pkt) => {
    if (pkt.length < 12) return;
    const payload = pkt.slice(12 + (pkt[0] & 0x0F) * 4);
    if (!payload.length) return;
    const pcm16k = resample8to16(ulawToPcm16(payload));
    const energy = rms(pcm16k);
    if (energy > MIN_ENERGY) {
      speechStarted = true;
      pcmAcc = Buffer.concat([pcmAcc, pcm16k]);
      clearTimeout(silenceTimer);
      silenceTimer = setTimeout(flush, SILENCE_MS);
    } else if (speechStarted) {
      pcmAcc = Buffer.concat([pcmAcc, pcm16k]);
    }
  });

  rtpSocket.on('error', e => log.error('Erro RTP', { error: e.message }));

  return () => {
    log.info('Encerrando sessão');
    clearTimeout(silenceTimer);
    try { rtpSocket.close(); } catch {}
    if (agentWs.readyState === WebSocket.OPEN) agentWs.close();
  };
}

// ─── drachtio SRF ────────────────────────────────────────────────────────────
const srf = new Srf();

function connectDrachtio() {
  srf.connect({ host: DRACHTIO_HOST, port: DRACHTIO_PORT, secret: DRACHTIO_SECRET });
}

srf.on('connect', (err, hostport) => {
  if (err) { console.error(JSON.stringify({ ts: new Date().toISOString(), level:'ERROR', msg:'drachtio connect error', error: err.message })); setTimeout(connectDrachtio, 3000); return; }
  console.log(JSON.stringify({ ts: new Date().toISOString(), level:'INFO', msg:'drachtio conectado', hostport }));
});

srf.on('error', (err) => {
  console.error(JSON.stringify({ ts: new Date().toISOString(), level:'ERROR', msg:'drachtio erro', error: err.message }));
  setTimeout(connectDrachtio, 3000);
});

// INVITE — usa createUAS para registrar o dialog e tratar BYE corretamente
srf.invite(async (req, res) => {
  const callId = `c${++callCounter}`;
  const log    = logger(callId);
  log.info('INVITE', { from: req.getParsedHeader('from')?.uri });

  try {
    const remoteSdp       = req.body;
    const remoteIpMatch   = remoteSdp.match(/c=IN IP4 ([\d.]+)/);
    const remotePortMatch = remoteSdp.match(/m=audio (\d+)/);

    if (!remoteIpMatch || !remotePortMatch) { log.error('SDP inválido'); res.send(488); return; }

    const remoteIp   = remoteIpMatch[1];
    const remotePort = parseInt(remotePortMatch[1]);
    const localPort  = allocRtpPort();
    log.info('Chamada', { remoteIp, remotePort, localPort, rtpHost: RTP_HOST });

    const rtpSocket = dgram.createSocket('udp4');
    await new Promise(r => rtpSocket.bind(localPort, '0.0.0.0', r));

    const localSdp = [
      'v=0', `o=- ${Date.now()} 1 IN IP4 ${RTP_HOST}`, 's=Voice Agent',
      `c=IN IP4 ${RTP_HOST}`, 't=0 0',
      `m=audio ${localPort} RTP/AVP 0`, 'a=rtpmap:0 PCMU/8000', 'a=sendrecv', '',
    ].join('\r\n');

    // createUAS cria e rastreia o dialog — BYE retorna 200 OK automaticamente
    const dialog = await srf.createUAS(req, res, { localSdp });
    log.info('Chamada atendida — dialog criado');

    const cleanup = await startAudioPipeline(remoteIp, remotePort, rtpSocket, log);

    dialog.on('destroy', () => {
      log.info('BYE recebido — encerrando');
      cleanup();
    });

  } catch(e) {
    log.error('Erro ao atender', { error: e.message });
    try { res.send(500); } catch {}
  }
});

// REGISTER — aceita qualquer ramal
srf.register((req, res) => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level:'INFO', msg:'REGISTER aceito', from: req.getParsedHeader('from')?.uri }));
  res.send(200, { headers: { 'Contact': req.get('contact'), 'Expires': req.get('expires') || '300' } });
});

// SUBSCRIBE — responde 200 OK para evitar spam de 503
srf.subscribe((req, res) => {
  res.send(200, { headers: { 'Expires': '0', 'Content-Length': '0' } });
});

connectDrachtio();

// ─── Health HTTP ──────────────────────────────────────────────────────────────
http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', calls: callCounter, rtpHost: RTP_HOST }));
  } else { res.writeHead(404); res.end(); }
}).listen(HTTP_PORT, () => {
  console.log(JSON.stringify({
    ts: new Date().toISOString(), level:'INFO',
    msg:'SIP Bridge pronto',
    drachtio: `${DRACHTIO_HOST}:${DRACHTIO_PORT}`,
    agent: AGENT_WS_URL,
    rtp: `${RTP_HOST}:${RTP_PORT_MIN}-${RTP_PORT_MAX}`,
    health: `http://localhost:${HTTP_PORT}/health`,
  }));
});