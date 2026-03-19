/**
 * Voice Agent — Production Server
 * Patterns: barge-in, rate limiting, message queue, timeout/cancel,
 *           structured logs, latency metrics, exponential backoff reconnect
 */

require('dotenv').config();
const http    = require('http');
const fs      = require('fs');
const path    = require('path');
const { WebSocketServer, WebSocket } = require('ws');
const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
const OpenAI  = require('openai');

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT          = process.env.PORT          || 3000;
const DEEPGRAM_KEY  = process.env.DEEPGRAM_KEY;
const INCEPTION_KEY = process.env.INCEPTION_KEY;
const RIME_KEY      = process.env.RIME_KEY;
const RIME_WS_URL   = 'wss://users-ws.rime.ai/ws3';
const MAX_REQUESTS_PER_MIN = parseInt(process.env.RATE_LIMIT || '20');

if (!DEEPGRAM_KEY || !INCEPTION_KEY || !RIME_KEY) {
  console.error('❌  Faltam variáveis: DEEPGRAM_KEY, INCEPTION_KEY, RIME_KEY');
  process.exit(1);
}

const inception = new OpenAI({
  baseURL: 'https://api.inceptionlabs.ai/v1',
  apiKey: INCEPTION_KEY,
});
const deepgram = createClient(DEEPGRAM_KEY);

// ─── Structured Logger ────────────────────────────────────────────────────────
function createLogger(sessionId) {
  const fmt = (level, component, msg, meta = {}) => {
    const entry = { ts: new Date().toISOString(), level, session: sessionId, component, msg, ...meta };
    console.log(JSON.stringify(entry));
  };
  return {
    info:  (c, m, meta) => fmt('INFO',  c, m, meta),
    warn:  (c, m, meta) => fmt('WARN',  c, m, meta),
    error: (c, m, meta) => fmt('ERROR', c, m, meta),
    debug: (c, m, meta) => fmt('DEBUG', c, m, meta),
  };
}

// ─── Latency Tracker ─────────────────────────────────────────────────────────
class LatencyTracker {
  constructor() { this.marks = {}; this.results = {}; }
  mark(name) { this.marks[name] = Date.now(); }
  measure(name, from, to) {
    if (this.marks[from] && this.marks[to]) {
      this.results[name] = this.marks[to] - this.marks[from];
    }
  }
  report() { return this.results; }
}

// ─── HTTP server ──────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html', '.js': 'application/javascript',
  '.mjs': 'application/javascript', '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream', '.css': 'text/css',
};

const httpServer = http.createServer((req, res) => {
  // Página principal
  if (req.url === '/' || req.url === '/index.html') {
    fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  // Arquivos estáticos da pasta /public (vad-web, onnx, wasm)
  const filePath = path.join(__dirname, 'public', path.basename(req.url));
  const ext      = path.extname(filePath);
  if (fs.existsSync(filePath)) {
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      // WASM e ONNX precisam de CORS para SharedArrayBuffer/AudioWorklet
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  res.writeHead(404); res.end();
});

// ─── WebSocket server ─────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer, path: '/agent' });
let sessionCounter = 0;

wss.on('connection', (clientWs, req) => {
  const sessionId = `s${++sessionCounter}`;
  const log = createLogger(sessionId);
  const url     = new URL(req.url, `http://localhost:${PORT}`);
  const speaker = url.searchParams.get('speaker')  || 'astra';
  const model   = url.searchParams.get('model')    || 'arcana';
  const lang    = url.searchParams.get('lang')     || 'por';
  const llmModel= url.searchParams.get('llmModel') || 'mercury-2';

  log.info('session', 'Nova conexão', { speaker, lang, model: llmModel });

  // ── Histórico LLM ─────────────────────────────────────────────────────────
  // ── Structured Output Schema ──────────────────────────────────────────────
  const RESPONSE_SCHEMA = {
    name: 'VoiceAgentResponse',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        thinking: {
          type: 'string',
          description: 'Internal chain-of-thought — not spoken aloud. Analyze the user message before responding.',
        },
        intent: {
          type: 'string',
          enum: ['question', 'schedule', 'cancel', 'complaint', 'compliment', 'smalltalk', 'command', 'other'],
          description: 'Primary intent detected in the user message.',
        },
        sentiment: {
          type: 'string',
          enum: ['positive', 'negative', 'neutral', 'frustrated', 'excited'],
          description: 'Emotional tone of the user message.',
        },
        confidence: {
          type: 'number',
          description: 'Confidence score for intent detection (0.0 to 1.0).',
        },
        entities: {
          type: 'object',
          properties: {
            names:   { type: 'array', items: { type: 'string' } },
            dates:   { type: 'array', items: { type: 'string' } },
            numbers: { type: 'array', items: { type: 'string' } },
          },
          required: ['names', 'dates', 'numbers'],
          additionalProperties: false,
        },
        spoken_response: {
          type: 'string',
          description: 'The actual response spoken aloud by the voice agent. Natural, concise, conversational.',
        },
      },
      required: ['thinking', 'intent', 'sentiment', 'confidence', 'entities', 'spoken_response'],
      additionalProperties: false,
    },
  };

  // ── System prompts por idioma ─────────────────────────────────────────────
  const SYSTEM_PROMPTS = {
    por: `Você é um assistente de voz prestativo e conciso.
Sempre responda usando o JSON schema fornecido.
- "thinking": raciocínio interno, nunca falado em voz alta.
- "spoken_response": resposta natural, breve e conversacional para ser sintetizada em voz.`,
    eng: `You are a helpful and concise voice assistant.
Always respond using the provided JSON schema.
- "thinking": internal reasoning, never spoken aloud.
- "spoken_response": natural, brief, conversational reply to be synthesized as speech.`,
    spa: `Eres un asistente de voz útil y conciso.
Responde siempre usando el esquema JSON proporcionado.
- "thinking": razonamiento interno, nunca hablado en voz alta.
- "spoken_response": respuesta natural y breve para ser sintetizada como voz.`,
    fra: `Tu es un assistant vocal utile et concis.
Réponds toujours en utilisant le schéma JSON fourni.
- "thinking": raisonnement interne, jamais prononcé à voix haute.
- "spoken_response": réponse naturelle et brève à synthétiser en voix.`,
    ger: `Du bist ein hilfreicher und präziser Sprachassistent.
Antworte immer mit dem bereitgestellten JSON-Schema.
- "thinking": internes Denken, niemals laut gesprochen.
- "spoken_response": natürliche, kurze Antwort für die Sprachsynthese.`,
  };

  // ── Histórico LLM ─────────────────────────────────────────────────────────
  const messages = [{ role: 'system', content: SYSTEM_PROMPTS[lang] || SYSTEM_PROMPTS['eng'] }];

  // ── Rate Limiter ──────────────────────────────────────────────────────────
  let requestsThisMinute = 0;
  const rlInterval = setInterval(() => { requestsThisMinute = 0; }, 60_000);

  function isRateLimited() {
    if (requestsThisMinute >= MAX_REQUESTS_PER_MIN) return true;
    requestsThisMinute++;
    return false;
  }

  // ── Message Queue (evita processamento paralelo) ──────────────────────────
  const messageQueue = [];
  let isProcessing   = false;

  async function enqueue(userText) {
    messageQueue.push(userText);
    if (!isProcessing) processQueue();
  }

  async function processQueue() {
    if (messageQueue.length === 0) { isProcessing = false; return; }
    isProcessing = true;
    const text = messageQueue.shift();
    await handleUserText(text);
    processQueue();
  }

  // ── Barge-in: cancela resposta em andamento ───────────────────────────────
  let currentAbortController = null;
  let isSpeaking = false;

  function bargeIn() {
    if (!isSpeaking && !isProcessing) return;
    log.info('barge-in', 'Interrupção detectada');

    if (currentAbortController) {
      currentAbortController.abort();
      currentAbortController = null;
    }

    if (rimeWs?.readyState === WebSocket.OPEN) {
      try { rimeWs.send(JSON.stringify({ operation: 'clear' })); } catch {}
      rimeWs.close();
    }
    rimeReady    = false;
    rimeQueue.length    = 0;
    messageQueue.length = 0; // ← limpa itens enfileirados
    isProcessing = false;
    isSpeaking   = false;
    speechFinalFired = false; // ← reseta flag para próxima fala
    pendingTranscript = '';

    send({ type: 'barge_in_ack' });
    log.info('barge-in', 'Resposta cancelada');
  }

  // ── Rime TTS ──────────────────────────────────────────────────────────────
  let rimeWs      = null;
  let rimeReady   = false;
  const rimeQueue = [];

  function connectRime(attempt = 0) {
    const rimeUrl = `${RIME_WS_URL}?speaker=${speaker}&modelId=${model}&lang=${lang}&audioFormat=mp3`;
    rimeWs = new WebSocket(rimeUrl, { headers: { Authorization: `Bearer ${RIME_KEY}` } });
    rimeWs.binaryType = 'nodebuffer';

    rimeWs.on('open', () => {
      rimeReady = true;
      log.info('rime', 'Conectado');
      for (const m of rimeQueue) rimeWs.send(m);
      rimeQueue.length = 0;
    });

    rimeWs.on('message', (data, isBinary) => {
      if (clientWs.readyState !== WebSocket.OPEN) return;
      if (isBinary) {
        send({ type: 'audio_chunk', data: data.toString('base64') });
      } else {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'chunk' && msg.data) {
          send({ type: 'audio_chunk', data: msg.data });
        } else if (msg.type === 'timestamps' || msg.word_timestamps) {
          send({ type: 'timestamps', payload: msg.word_timestamps || msg.timestamps });
        } else if (msg.type === 'done') {
          isSpeaking = false;
          send({ type: 'audio_done' });
          log.info('rime', 'Síntese concluída');
        }
      }
    });

    rimeWs.on('error', (e) => {
      log.error('rime', 'Erro WebSocket', { error: e.message });
    });

    rimeWs.on('close', (code) => {
      rimeReady = false;
      log.info('rime', 'Fechado', { code });
      // Backoff exponencial apenas se fechou inesperadamente durante síntese
      if (isSpeaking && attempt < 4) {
        const delay = Math.min(200 * Math.pow(2, attempt), 3000);
        log.warn('rime', `Reconectando em ${delay}ms (tentativa ${attempt + 1})`);
        setTimeout(() => connectRime(attempt + 1), delay);
      }
    });
  }

  function rimeSend(text) {
    const msg = JSON.stringify({ text });
    if (rimeReady && rimeWs?.readyState === WebSocket.OPEN) rimeWs.send(msg);
    else rimeQueue.push(msg);
  }

  function rimeFlush() {
    const msg = JSON.stringify({ operation: 'eos' });
    if (rimeReady && rimeWs?.readyState === WebSocket.OPEN) rimeWs.send(msg);
    else rimeQueue.push(msg);
  }

  connectRime();

  // ── Deepgram STT ──────────────────────────────────────────────────────────
  let dgLive      = null;
  let dgConnected = false;
  let lastTriggeredText = '';  // evita disparar a mesma frase duas vezes
  let speechFinalFired  = false; // flag: speech_final já disparou nessa utterance

  // Detecção de fim de fala inteligente
  let silenceTimer      = null;
  let pendingTranscript = '';
  const SILENCE_TIMEOUT = 1200;

  function connectDeepgram() {
    const dgLang = lang === 'por' ? 'pt-BR' : lang === 'spa' ? 'es' : lang === 'fra' ? 'fr' : 'en-US';
    dgLive = deepgram.listen.live({
      model:            'nova-3',
      language:         dgLang,
      smart_format:     true,
      interim_results:  true,
      vad_events:       true,
      endpointing:      300,
      utterance_end_ms: 1000,
      encoding:         'linear16',
      sample_rate:      16000,
    });

    dgLive.on(LiveTranscriptionEvents.Open, () => {
      dgConnected = true;
      log.info('deepgram', 'Conectado', { lang: dgLang });
      send({ type: 'stt_ready' });
    });

    dgLive.on(LiveTranscriptionEvents.Transcript, (data) => {
      const alt     = data.channel?.alternatives?.[0];
      const text    = alt?.transcript || '';
      const isFinal = data.is_final;
      const speechEnd = data.speech_final;

      if (!text) return;

      if (isFinal) pendingTranscript = text;

      send({ type: 'transcript', text, isFinal, speechFinal: speechEnd });

      // Barge-in: só se agente está falando E texto é novo (não eco do agente)
      if (text && isSpeaking && text !== lastTriggeredText) {
        bargeIn();
        return;
      }

      // speech_final — dispara LLM uma única vez por utterance
      if (speechEnd && text.trim() && !speechFinalFired) {
        speechFinalFired = true;
        clearTimeout(silenceTimer);
        log.info('deepgram', 'Frase final (speech_final)', { text });
        triggerLLM(text.trim());
        return;
      }

      // Fallback timer de silêncio (só se speech_final não veio)
      if (isFinal && text.trim() && !speechFinalFired) {
        clearTimeout(silenceTimer);
        silenceTimer = setTimeout(() => {
          if (pendingTranscript.trim() && !speechFinalFired) {
            speechFinalFired = true;
            log.info('deepgram', 'Frase final (silence timeout)', { text: pendingTranscript });
            triggerLLM(pendingTranscript.trim());
            pendingTranscript = '';
          }
        }, SILENCE_TIMEOUT);
      }
    });

    dgLive.on(LiveTranscriptionEvents.SpeechStarted, () => {
      // Reseta flags a cada nova fala
      speechFinalFired = false;
      pendingTranscript = '';
      send({ type: 'speech_started' });
    });

    dgLive.on(LiveTranscriptionEvents.UtteranceEnd, () => {
      clearTimeout(silenceTimer);
      // utterance_end só dispara se speech_final NÃO veio
      if (pendingTranscript.trim() && !speechFinalFired && !isProcessing) {
        speechFinalFired = true;
        log.info('deepgram', 'Frase final (utterance_end)', { text: pendingTranscript });
        triggerLLM(pendingTranscript.trim());
        pendingTranscript = '';
      }
      send({ type: 'speech_ended' });
    });

    dgLive.on(LiveTranscriptionEvents.Error, (e) => {
      log.error('deepgram', 'Erro', { error: String(e) });
      send({ type: 'error', source: 'stt', message: String(e) });
    });

    dgLive.on(LiveTranscriptionEvents.Close, () => {
      dgConnected = false;
      log.info('deepgram', 'Fechado');
    });
  }

  function triggerLLM(text) {
    if (isRateLimited()) {
      log.warn('rate-limit', 'Requisição bloqueada', { text });
      send({ type: 'error', source: 'rate_limit', message: 'Muitas requisições. Aguarde.' });
      return;
    }
    lastTriggeredText = text; // registra para evitar barge-in de eco
    enqueue(text);
  }

  // ── Pipeline LLM → TTS ────────────────────────────────────────────────────
  const LLM_TIMEOUT_MS = 15_000;

  async function handleUserText(userText) {
    const tracker = new LatencyTracker();
    tracker.mark('start');

    // Reconecta Rime em paralelo
    if (rimeWs) rimeWs.close();
    rimeReady = false;
    rimeQueue.length = 0;
    connectRime();

    messages.push({ role: 'user', content: userText });
    send({ type: 'llm_start' });
    log.info('llm', 'Iniciando', { text: userText });

    currentAbortController = new AbortController();
    const timeoutId = setTimeout(() => {
      log.warn('llm', 'Timeout atingido');
      currentAbortController?.abort();
    }, LLM_TIMEOUT_MS);

    try {
      tracker.mark('llm_start');

      // Structured output — sem streaming (JSON precisa estar completo para parsear)
      const completion = await inception.chat.completions.create(
        {
          model: llmModel,
          messages,
          stream: false,
          extra_body: { reasoning_effort: 'instant' },
          response_format: {
            type: 'json_schema',
            json_schema: RESPONSE_SCHEMA,
          },
        },
        { signal: currentAbortController.signal }
      );

      tracker.mark('llm_done');
      tracker.measure('llm_total', 'llm_start', 'llm_done');

      // Parseia o JSON estruturado
      const raw      = completion.choices[0]?.message?.content || '{}';
      const parsed   = JSON.parse(raw);
      const spoken   = parsed.spoken_response || '';
      const intent   = parsed.intent   || 'other';
      const sentiment= parsed.sentiment || 'neutral';
      const entities = parsed.entities || { names: [], dates: [], numbers: [] };
      const thinking = parsed.thinking || '';

      log.info('llm', 'Concluído', {
        intent,
        sentiment,
        confidence: parsed.confidence,
        entities,
        chars: spoken.length,
        latency: tracker.report(),
      });

      // Envia tokens simulados ao browser (para exibir no chat)
      // Divide em palavras para simular streaming visual
      const words = spoken.split(' ');
      for (const word of words) {
        if (currentAbortController?.signal.aborted) break;
        send({ type: 'llm_token', token: word + ' ' });
      }

      // Envia metadados estruturados ao frontend
      send({
        type: 'llm_structured',
        intent,
        sentiment,
        confidence: parsed.confidence,
        entities,
        thinking,
      });

      // Envia resposta falada ao Rime TTS
      if (spoken.trim()) {
        rimeSend(spoken);
        rimeFlush();
        isSpeaking = true;
      }

      // Salva no histórico apenas a resposta falada (não o JSON completo)
      messages.push({ role: 'assistant', content: spoken });
      send({ type: 'llm_done', fullText: spoken });

    } catch (e) {
      if (e.name === 'AbortError') {
        log.info('llm', 'Cancelado (barge-in ou timeout)');
      } else {
        log.error('llm', 'Erro', { error: e.message });
        send({ type: 'error', source: 'llm', message: 'Erro ao processar resposta.' });
      }
    } finally {
      clearTimeout(timeoutId);
      currentAbortController = null;
    }
  }

  // ── Helper send ───────────────────────────────────────────────────────────
  function send(obj) {
    if (clientWs.readyState === WebSocket.OPEN)
      clientWs.send(JSON.stringify(obj));
  }

  // ── Mensagens do browser ──────────────────────────────────────────────────
  clientWs.on('message', async (raw, isBinary) => {
    if (isBinary) {
      if (dgConnected) dgLive.send(raw);
      return;
    }

    const msg = JSON.parse(raw.toString());

    if (msg.type === 'audio') {
      if (dgConnected) dgLive.send(Buffer.from(msg.data, 'base64'));
      return;
    }

    // Áudio completo segmentado pelo Silero VAD
    if (msg.type === 'vad_audio_complete') {
      log.info('vad', 'Segmento recebido', { durationMs: msg.durationMs });

      // Descarta segmentos muito curtos (eco/ruído) — menos de 500ms
      if (msg.durationMs < 500) {
        log.warn('vad', 'Segmento descartado (muito curto)', { durationMs: msg.durationMs });
        return;
      }

      if (!dgConnected) connectDeepgram();
      const waitDg = new Promise(resolve => {
        if (dgConnected) return resolve();
        const iv = setInterval(() => { if (dgConnected) { clearInterval(iv); resolve(); } }, 50);
        setTimeout(() => { clearInterval(iv); resolve(); }, 2000);
      });
      await waitDg;
      if (dgConnected) {
        const buf = Buffer.from(msg.data, 'base64');
        dgLive.send(buf);
        setTimeout(() => { try { dgLive.requestClose(); dgConnected = false; } catch {} }, 300);
      }
      return;
    }

    switch (msg.type) {
      case 'start_listening':
        if (!dgConnected) connectDeepgram();
        break;
      case 'stop_listening':
        clearTimeout(silenceTimer);
        if (dgConnected) { try { dgLive.requestClose(); } catch {} dgConnected = false; }
        break;
      case 'barge_in':
        bargeIn();
        break;
      case 'text_message':
        send({ type: 'transcript', text: msg.text, isFinal: true, speechFinal: true });
        triggerLLM(msg.text);
        break;
      case 'ping':
        send({ type: 'pong', ts: Date.now() });
        break;
    }
  });

  // ── Cleanup ───────────────────────────────────────────────────────────────
  clientWs.on('close', () => {
    log.info('session', 'Browser desconectou');
    clearTimeout(silenceTimer);
    clearInterval(rlInterval);
    if (currentAbortController) currentAbortController.abort();
    if (dgLive && dgConnected) try { dgLive.requestClose(); } catch {}
    if (rimeWs) try { rimeWs.close(); } catch {}
  });

  clientWs.on('error', (e) => log.error('session', 'Erro WS', { error: e.message }));
});

// ─── Start ────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'INFO', msg: `Voice Agent rodando em http://localhost:${PORT}` }));
});