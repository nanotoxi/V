import http from 'http'
import { WebSocketServer } from 'ws'
import Groq from 'groq-sdk'
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js'

// ─── Config ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001
const GROQ_API_KEY = process.env.GROQ_API_KEY
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'JBFqnCBsd6RMkjVDRZzb'
const MAIN_PLATFORM_URL = process.env.MAIN_PLATFORM_URL
const MAIN_PLATFORM_SECRET = process.env.MAIN_PLATFORM_SECRET
const PLIVO_AUTH_ID = process.env.PLIVO_AUTH_ID || 'MAMTNIM2UZZJUTYZY0ZI'
const PLIVO_AUTH_TOKEN = process.env.PLIVO_AUTH_TOKEN || 'MDY5NGY3NTUtNTBiZC00ZDk5LTc2NzItYzczNGI5'
const AGENT_URL = process.env.AGENT_URL || `http://localhost:${PORT}`

const PLIVO_AUTH_HEADER = 'Basic ' + Buffer.from(`${PLIVO_AUTH_ID}:${PLIVO_AUTH_TOKEN}`).toString('base64')

// ─── Questions ────────────────────────────────────────────────────────────────
const QUESTIONS = [
  { field: 'noticePeriod', text: 'What is your current notice period? You can just say the number of days.' },
  { field: 'currentCtc', text: 'What is your current C T C — your annual salary in lakhs?' },
  { field: 'expectedCtc', text: 'And what is your expected C T C — the salary you are targeting for your next role?' },
  { field: 'activelyLooking', text: 'Last question. Are you actively looking for a new job right now, or just exploring options?' },
]

const ACKS = ['Got it.', 'Perfect, thank you.', 'Understood.', 'Great.']

// ─── In-memory sessions ───────────────────────────────────────────────────────
const sessions = new Map()

// ─── HTTP server ──────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('Zynq Voice Agent OK')
    return
  }

  if (req.method === 'POST' && url.pathname === '/answer') {
    let body = ''
    req.on('data', d => body += d)
    req.on('end', async () => {
      const plivoParams = Object.fromEntries(new URLSearchParams(body))
      const callUuid = plivoParams.CallUUID || plivoParams.call_uuid || ''

      const candidateId = url.searchParams.get('candidateId') || ''
      const candidateName = decodeURIComponent(url.searchParams.get('candidateName') || 'there')
      const jobTitle = decodeURIComponent(url.searchParams.get('jobTitle') || 'this role')
      const agencyName = decodeURIComponent(url.searchParams.get('agencyName') || 'our team')

      console.log(`[HTTP] /answer — callUuid:${callUuid} candidate:${candidateName}`)

      // Keep call alive while WebSocket stream handles the conversation
      res.writeHead(200, { 'Content-Type': 'application/xml' })
      res.end(`<?xml version="1.0" encoding="UTF-8"?><Response><Wait length="600" /></Response>`)

      // Start bidirectional stream via Plivo REST API
      const wsUrl = AGENT_URL.replace('https://', 'wss://').replace('http://', 'ws://') + '/stream'
      try {
        const streamRes = await fetch(`https://api.plivo.com/v1/Account/${PLIVO_AUTH_ID}/Call/${callUuid}/Stream/`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': PLIVO_AUTH_HEADER },
          body: JSON.stringify({
            service_url: wsUrl,
            bidirectional: true,
            audio_track: 'inbound',
            customParameters: { candidateId, candidateName, jobTitle, agencyName },
          }),
        })
        const streamData = await streamRes.json()
        console.log(`[HTTP] Stream started:`, streamData)
      } catch (err) {
        console.error('[HTTP] Stream start error:', err.message)
      }
    })
    return
  }

  if (req.method === 'POST' && url.pathname === '/hangup') {
    let body = ''
    req.on('data', d => body += d)
    req.on('end', () => {
      try {
        const params = Object.fromEntries(new URLSearchParams(body))
        console.log(`[HTTP] /hangup — uuid:${params.CallUUID} duration:${params.Duration}s cause:${params.HangupCause}`)
      } catch {}
      res.writeHead(200)
      res.end()
    })
    return
  }

  res.writeHead(404)
  res.end()
})

// ─── WebSocket server ─────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: '/stream' })

wss.on('connection', (ws) => {
  const peerId = Math.random().toString(36).slice(2)
  console.log(`[WS] Connected: ${peerId}`)

  ws.on('message', async (raw) => {
    let data
    try { data = JSON.parse(raw.toString()) } catch { return }

    if (data.event === 'start') {
      const params = data.start?.customParameters || {}
      const callUuid = data.start?.callId || data.start?.callUuid || data.start?.callSid || ''
      const session = {
        peerId,
        callUuid,
        candidateId: params.candidateId || '',
        candidateName: decodeURIComponent(params.candidateName || 'there'),
        firstName: decodeURIComponent(params.candidateName || 'there').split(' ')[0],
        jobTitle: decodeURIComponent(params.jobTitle || 'this role'),
        agencyName: decodeURIComponent(params.agencyName || 'our team'),
        audioChunks: [],
        silenceTimer: null,
        questionIndex: -1,
        isPlaying: true,
        answers: {},
      }
      sessions.set(peerId, session)
      console.log(`[WS] Session started for ${session.candidateName}, callUuid:${callUuid}`)

      const greeting = `Hi ${session.firstName}! This is a quick screening call from ${session.agencyName} regarding your application for the ${session.jobTitle} position. I just have 4 short questions — it will take under 2 minutes.`
      await speakAndListen(ws, session, greeting, 0)
    }

    if (data.event === 'media') {
      const session = sessions.get(peerId)
      if (!session || session.isPlaying) return
      session.audioChunks.push(Buffer.from(data.media.payload, 'base64'))
      if (session.silenceTimer) clearTimeout(session.silenceTimer)
      session.silenceTimer = setTimeout(() => onSilence(ws, session), 1500)
    }

    if (data.event === 'stop') cleanup(peerId)
  })

  ws.on('close', () => { console.log(`[WS] Disconnected: ${peerId}`); cleanup(peerId) })
  ws.on('error', (err) => { console.error(`[WS] Error ${peerId}:`, err.message); cleanup(peerId) })
})

function cleanup(peerId) {
  const session = sessions.get(peerId)
  if (session?.silenceTimer) clearTimeout(session.silenceTimer)
  sessions.delete(peerId)
}

// ─── Silence → transcribe → respond ──────────────────────────────────────────
async function onSilence(ws, session) {
  if (session.audioChunks.length < 8) {
    session.audioChunks = []
    return
  }

  const audioData = Buffer.concat(session.audioChunks)
  session.audioChunks = []
  session.isPlaying = true

  let transcript = ''
  try {
    const groq = new Groq({ apiKey: GROQ_API_KEY })
    const wavBuffer = mulawToWav(audioData)
    const audioFile = new File([wavBuffer], 'answer.wav', { type: 'audio/wav' })
    const result = await groq.audio.transcriptions.create({ file: audioFile, model: 'whisper-large-v3', language: 'en' })
    transcript = result.text.trim()
    console.log(`[WS] Q${session.questionIndex} — "${transcript}"`)
  } catch (err) {
    console.error('[WS] Transcription error:', err.message)
    transcript = 'unclear'
  }

  const q = QUESTIONS[session.questionIndex]
  if (q) session.answers[q.field] = transcript || 'no_response'

  const nextIndex = session.questionIndex + 1
  if (nextIndex >= QUESTIONS.length) {
    const closing = `Thank you so much, ${session.firstName}! That is everything we needed. The team at ${session.agencyName} will review your details and be in touch within 2 business days. Have a wonderful day!`
    await speak(ws, closing)
    await saveAnswers(session)
    // Hang up via Plivo REST API
    if (session.callUuid) {
      try {
        await fetch(`https://api.plivo.com/v1/Account/${PLIVO_AUTH_ID}/Call/${session.callUuid}/`, {
          method: 'DELETE',
          headers: { 'Authorization': PLIVO_AUTH_HEADER },
        })
        console.log(`[WS] Call hung up: ${session.callUuid}`)
      } catch (err) {
        console.error('[WS] Hangup error:', err.message)
      }
    }
    return
  }

  const ack = ACKS[session.questionIndex % ACKS.length]
  await speakAndListen(ws, session, `${ack} ${QUESTIONS[nextIndex].text}`, nextIndex)
}

// ─── Audio helpers ────────────────────────────────────────────────────────────
async function speakAndListen(ws, session, text, nextQuestionIndex) {
  session.isPlaying = true
  session.audioChunks = []
  await speak(ws, text)
  session.questionIndex = nextQuestionIndex
  session.isPlaying = false
}

async function speak(ws, text) {
  if (ws.readyState !== 1) return
  try {
    const elevenlabs = new ElevenLabsClient({ apiKey: ELEVENLABS_API_KEY })
    const audio = await elevenlabs.textToSpeech.convert(ELEVENLABS_VOICE_ID, {
      text,
      modelId: 'eleven_multilingual_v2',
      outputFormat: 'ulaw_8000',
    })
    for await (const chunk of audio) {
      if (ws.readyState !== 1) break
      ws.send(JSON.stringify({ event: 'media', media: { payload: Buffer.from(chunk).toString('base64') } }))
    }
    await new Promise(r => setTimeout(r, 400))
  } catch (err) {
    console.error('[WS] ElevenLabs error:', err.message)
  }
}

// ─── Save answers to main platform ───────────────────────────────────────────
async function saveAnswers(session) {
  if (!MAIN_PLATFORM_URL || !session.candidateId) {
    console.log('[WS] Answers (no platform save):', session.answers)
    return
  }
  try {
    const res = await fetch(`${MAIN_PLATFORM_URL}/api/voice/results`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ candidateId: session.candidateId, secret: MAIN_PLATFORM_SECRET, ...session.answers }),
    })
    console.log(`[WS] Answers saved: ${res.status}`)
  } catch (err) {
    console.error('[WS] Save error:', err.message)
  }
}

// ─── mulaw → WAV ─────────────────────────────────────────────────────────────
function mulawToWav(mulawData) {
  const pcm = new Int16Array(mulawData.length)
  for (let i = 0; i < mulawData.length; i++) {
    let u = (~mulawData[i]) & 0xff
    const sign = u & 0x80
    const exp = (u >> 4) & 0x07
    const mant = u & 0x0f
    let s = ((mant << 1) + 33) << (exp + 2)
    pcm[i] = sign ? -s : s
  }
  const pcmBuf = Buffer.from(pcm.buffer)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcmBuf.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(8000, 24)
  header.writeUInt32LE(16000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcmBuf.length, 40)
  return Buffer.concat([header, pcmBuf])
}

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`[Voice Agent] Listening on port ${PORT}`)
  console.log(`  /answer → Plivo answer webhook`)
  console.log(`  /hangup → Plivo hangup webhook`)
  console.log(`  /stream → WebSocket bidirectional audio`)
})
