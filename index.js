import http from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import Groq from 'groq-sdk'

// ─── Config ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY
const GROQ_API_KEY = process.env.GROQ_API_KEY
const MAIN_PLATFORM_URL = process.env.MAIN_PLATFORM_URL
const MAIN_PLATFORM_SECRET = process.env.MAIN_PLATFORM_SECRET
const PLIVO_AUTH_ID = process.env.PLIVO_AUTH_ID || 'MAMTNIM2UZZJUTYZY0ZI'
const PLIVO_AUTH_TOKEN = process.env.PLIVO_AUTH_TOKEN || 'MDY5NGY3NTUtNTBiZC00ZDk5LTc2NzItYzczNGI5'
const AGENT_URL = process.env.AGENT_URL || `http://localhost:${PORT}`
const PLIVO_AUTH_HEADER = 'Basic ' + Buffer.from(`${PLIVO_AUTH_ID}:${PLIVO_AUTH_TOKEN}`).toString('base64')

// ─── Questions ────────────────────────────────────────────────────────────────
const QUESTIONS = [
  { field: 'noticePeriod', text: 'What is your current notice period?' },
  { field: 'currentCtc', text: 'What is your current CTC — your annual salary in lakhs?' },
  { field: 'expectedCtc', text: 'And what salary are you looking for in your next role?' },
  { field: 'activelyLooking', text: 'Are you actively looking right now, or just exploring options?' },
]
const ACKS = ['Got it.', 'Sure.', 'Noted.', 'Great.']

// ─── Pending call info (answer URL → WS bridge) ───────────────────────────────
const pendingCalls = new Map()

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
      const callUuid = plivoParams.CallUUID || ''
      const candidateId = url.searchParams.get('candidateId') || ''
      const candidateName = decodeURIComponent(url.searchParams.get('candidateName') || 'there')
      const jobTitle = decodeURIComponent(url.searchParams.get('jobTitle') || 'this role')
      const agencyName = decodeURIComponent(url.searchParams.get('agencyName') || 'our team')

      console.log(`[HTTP] /answer — callUuid:${callUuid} candidate:${candidateName}`)

      // Store call info for when WS connects (Plivo doesn't pass customParams in start event)
      pendingCalls.set(callUuid, { candidateId, candidateName, jobTitle, agencyName })
      setTimeout(() => pendingCalls.delete(callUuid), 120000)

      res.writeHead(200, { 'Content-Type': 'application/xml' })
      res.end(`<?xml version="1.0" encoding="UTF-8"?><Response><Wait length="600" /></Response>`)

      const wsUrl = AGENT_URL.replace('https://', 'wss://').replace('http://', 'ws://') + '/stream'
      try {
        const r = await fetch(`https://api.plivo.com/v1/Account/${PLIVO_AUTH_ID}/Call/${callUuid}/Stream/`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: PLIVO_AUTH_HEADER },
          body: JSON.stringify({ service_url: wsUrl, bidirectional: true, audio_track: 'inbound' }),
        })
        const d = await r.json()
        console.log(`[HTTP] Stream:`, d.message || JSON.stringify(d))
      } catch (err) {
        console.error('[HTTP] Stream error:', err.message)
      }
    })
    return
  }

  if (req.method === 'POST' && url.pathname === '/hangup') {
    let body = ''
    req.on('data', d => body += d)
    req.on('end', () => {
      try {
        const p = Object.fromEntries(new URLSearchParams(body))
        console.log(`[HTTP] /hangup — ${p.CallUUID} ${p.Duration}s ${p.HangupCause}`)
      } catch {}
      res.writeHead(200); res.end()
    })
    return
  }

  res.writeHead(404); res.end()
})

// ─── WebSocket server ─────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: '/stream' })

wss.on('connection', (plivoWs) => {
  console.log('[WS] Plivo connected')
  const session = {
    plivoWs,
    callUuid: '',
    candidateId: '',
    candidateName: 'there',
    firstName: 'there',
    jobTitle: 'this role',
    agencyName: 'our team',
    questionIndex: 0,
    answers: {},
    isPlaying: true,
    dgSttWs: null,
    transcript: '',
  }

  plivoWs.on('message', async (raw) => {
    let data
    try { data = JSON.parse(raw.toString()) } catch { return }

    if (data.event === 'start') {
      session.callUuid = data.start?.callId || ''
      const info = pendingCalls.get(session.callUuid) || {}
      session.candidateId = info.candidateId || ''
      session.candidateName = info.candidateName || 'there'
      session.firstName = session.candidateName.split(' ')[0]
      session.jobTitle = info.jobTitle || 'this role'
      session.agencyName = info.agencyName || 'our team'
      console.log(`[WS] Call started: ${session.candidateName} | ${session.jobTitle}`)

      // Greet candidate first, THEN open STT (avoid Deepgram timeout while TTS plays)
      const greeting = `Hi ${session.firstName}, this is a call from ${session.agencyName} about your application for ${session.jobTitle}. I just have 4 quick questions.`
      await speakToPlivo(session, greeting)
      await speakToPlivo(session, QUESTIONS[0].text)

      // Now open STT — we're ready to listen
      session.dgSttWs = connectSTT(session)
      session.isPlaying = false
    }

    if (data.event === 'media' && session.dgSttWs?.readyState === 1 && !session.isPlaying) {
      session.dgSttWs.send(Buffer.from(data.media.payload, 'base64'))
    }

    if (data.event === 'stop') {
      session.dgSttWs?.close()
    }
  })

  plivoWs.on('close', () => {
    console.log('[WS] Plivo disconnected')
    session.dgSttWs?.close()
  })
  plivoWs.on('error', err => console.error('[WS] Plivo error:', err.message))
})

// ─── Deepgram STT ─────────────────────────────────────────────────────────────
function connectSTT(session) {
  const ws = new WebSocket(
    `wss://api.deepgram.com/v1/listen?model=nova-3&encoding=linear16&sample_rate=8000&endpointing=1500&utterance_end_ms=1500&interim_results=false&smart_format=true`,
    { headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` } }
  )

  ws.on('open', () => console.log('[STT] Connected'))
  ws.on('error', err => console.error('[STT] Error:', err.message))
  ws.on('close', () => console.log('[STT] Closed'))

  ws.on('message', async (raw) => {
    if (session.isPlaying) return
    let event
    try { event = JSON.parse(raw.toString()) } catch { return }

    if ((event.type === 'Results' && event.speech_final) || event.type === 'UtteranceEnd') {
      if (session.isPlaying) return
      const transcript = event.channel?.alternatives?.[0]?.transcript?.trim() || session._lastTranscript || ''
      if (!transcript) return
      session._lastTranscript = ''
      console.log(`[STT] Q${session.questionIndex}: "${transcript}"`)
      await handleAnswer(session, transcript)
    }
    if (event.type === 'Results' && !event.speech_final) {
      // Buffer interim so UtteranceEnd can use it as fallback
      const t = event.channel?.alternatives?.[0]?.transcript?.trim()
      if (t) session._lastTranscript = t
    }
  })

  return ws
}

// ─── Conversation logic ───────────────────────────────────────────────────────
async function handleAnswer(session, transcript) {
  session.isPlaying = true

  const q = QUESTIONS[session.questionIndex]
  if (q) session.answers[q.field] = transcript

  session.questionIndex++

  if (session.questionIndex >= QUESTIONS.length) {
    await speakToPlivo(session, `Thank you so much, ${session.firstName}! That is everything we needed. The team at ${session.agencyName} will be in touch within 2 business days. Have a wonderful day!`)
    await saveAnswers(session)
    setTimeout(() => hangUpCall(session.callUuid), 2000)
    return
  }

  const ack = ACKS[(session.questionIndex - 1) % ACKS.length]
  await speakToPlivo(session, `${ack} ${QUESTIONS[session.questionIndex].text}`)
  session.isPlaying = false
}

// ─── Deepgram TTS ─────────────────────────────────────────────────────────────
async function speakToPlivo(session, text) {
  console.log(`[TTS] Speaking: "${text.slice(0, 60)}..."`)
  try {
    const res = await fetch(
      `https://api.deepgram.com/v1/speak?model=aura-2-asteria-en&encoding=linear16&sample_rate=8000&container=none`,
      {
        method: 'POST',
        headers: { Authorization: `Token ${DEEPGRAM_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      }
    )
    if (!res.ok) {
      const err = await res.text()
      console.error('[TTS] Error:', err)
      return
    }
    const audioBuffer = Buffer.from(await res.arrayBuffer())
    const mulaw = linear16ToMulaw(audioBuffer)

    // Send in 20ms chunks (160 bytes at 8kHz mulaw)
    const CHUNK = 160
    for (let i = 0; i < mulaw.length; i += CHUNK) {
      if (session.plivoWs.readyState !== 1) break
      session.plivoWs.send(JSON.stringify({
        event: 'playAudio',
        media: { contentType: 'audio/x-mulaw', sampleRate: 8000, payload: mulaw.slice(i, i + CHUNK).toString('base64') },
      }))
    }

    // Wait for audio to finish playing (length / 8000 samples/sec * 1000ms + buffer)
    await new Promise(r => setTimeout(r, Math.ceil((mulaw.length / 8000) * 1000) + 300))
  } catch (err) {
    console.error('[TTS] Fetch error:', err.message)
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function hangUpCall(callUuid) {
  if (!callUuid) return
  try {
    await fetch(`https://api.plivo.com/v1/Account/${PLIVO_AUTH_ID}/Call/${callUuid}/`, {
      method: 'DELETE', headers: { Authorization: PLIVO_AUTH_HEADER },
    })
    console.log(`[HTTP] Call hung up: ${callUuid}`)
  } catch (err) {
    console.error('[HTTP] Hangup error:', err.message)
  }
}

async function saveAnswers(session) {
  console.log('[WS] Answers:', session.answers)
  if (!MAIN_PLATFORM_URL || !session.candidateId) return
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

// ─── linear16 → mulaw ─────────────────────────────────────────────────────────
function linear16ToMulaw(buf) {
  const samples = Math.floor(buf.length / 2)
  const out = Buffer.alloc(samples)
  for (let i = 0; i < samples; i++) {
    out[i] = encodeMulaw(buf.readInt16LE(i * 2))
  }
  return out
}

function encodeMulaw(s) {
  const BIAS = 0x84, CLIP = 32635
  let sign = 0
  if (s < 0) { sign = 0x80; s = -s }
  if (s > CLIP) s = CLIP
  s += BIAS
  let exp = 7
  for (let m = 0x4000; (s & m) === 0 && exp > 0; exp--, m >>= 1) {}
  return (~(sign | (exp << 4) | ((s >> (exp + 3)) & 0x0F))) & 0xFF
}

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`[Voice Agent] Listening on port ${PORT}`)
})
