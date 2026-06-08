import http from 'http'
import { WebSocketServer, WebSocket } from 'ws'

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

// ─── Deepgram Voice Agent settings builder ────────────────────────────────────
function buildSettings(firstName, jobTitle, agencyName) {
  return {
    type: 'Settings',
    audio: {
      input:  { encoding: 'mulaw', sample_rate: 8000 },
      output: { encoding: 'linear16', sample_rate: 8000, container: 'none' },
    },
    agent: {
      listen: {
        provider: { type: 'deepgram', model: 'nova-3' },
      },
      think: {
        provider: {
          type: 'open_ai',
          model: 'llama-3.3-70b-versatile',
          endpoint: { url: 'https://api.groq.com/openai/v1', headers: { Authorization: `Bearer ${GROQ_API_KEY}` } },
        },
        prompt: `You are a professional HR screening assistant calling on behalf of ${agencyName}.
You are speaking with ${firstName} about their application for ${jobTitle}.

Your job is to ask exactly these 4 questions in order, one at a time:
1. What is your current notice period?
2. What is your current CTC — your annual salary in lakhs?
3. What is your expected CTC — the salary you are targeting?
4. Are you actively looking for a new job, or just exploring options?

Guidelines:
- Be warm and conversational, not robotic.
- Wait for the full answer before moving to the next question.
- If the answer is unclear, ask once for clarification.
- After collecting all 4 answers, call the save_answers function immediately.
- Then say a warm goodbye and end the call.`,
        functions: [
          {
            name: 'save_answers',
            description: 'Save all 4 screening answers once collected. Call this only after you have answers for all 4 questions.',
            parameters: {
              type: 'object',
              properties: {
                noticePeriod:    { type: 'string', description: "Candidate's current notice period" },
                currentCtc:      { type: 'string', description: "Candidate's current annual CTC in lakhs" },
                expectedCtc:     { type: 'string', description: "Candidate's expected annual CTC in lakhs" },
                activelyLooking: { type: 'string', description: "Whether actively looking or just exploring" },
              },
              required: ['noticePeriod', 'currentCtc', 'expectedCtc', 'activelyLooking'],
            },
          },
        ],
      },
      speak: {
        provider: { type: 'deepgram', model: 'aura-2-odysseus-en' },
      },
      greeting: `Hi ${firstName}! This is a quick screening call from ${agencyName} regarding your application for the ${jobTitle} position. I have just 4 short questions for you — it will take under 2 minutes. Shall we get started?`,
    },
  }
}

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

      // Keep call alive while Deepgram Voice Agent handles conversation
      res.writeHead(200, { 'Content-Type': 'application/xml' })
      res.end(`<?xml version="1.0" encoding="UTF-8"?><Response><Wait length="600" /></Response>`)

      // Start bidirectional Plivo stream
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
        console.log(`[HTTP] Stream result:`, JSON.stringify(streamData))
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
        const p = Object.fromEntries(new URLSearchParams(body))
        console.log(`[HTTP] /hangup — uuid:${p.CallUUID} duration:${p.Duration}s cause:${p.HangupCause}`)
      } catch {}
      res.writeHead(200)
      res.end()
    })
    return
  }

  res.writeHead(404)
  res.end()
})

// ─── Plivo WebSocket server ───────────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: '/stream' })

wss.on('connection', (plivoWs) => {
  const peerId = Math.random().toString(36).slice(2)
  console.log(`[WS] Plivo connected: ${peerId}`)

  let deepgramWs = null
  let callUuid = ''
  let candidateId = ''
  let candidateName = ''
  let jobTitle = ''
  let agencyName = ''

  plivoWs.on('message', async (raw) => {
    let data
    try { data = JSON.parse(raw.toString()) } catch { return }

    if (data.event === 'start') {
      const params = data.start?.customParameters || {}
      callUuid = data.start?.callId || data.start?.callUuid || ''
      candidateId = params.candidateId || ''
      candidateName = decodeURIComponent(params.candidateName || 'there')
      jobTitle = decodeURIComponent(params.jobTitle || 'this role')
      agencyName = decodeURIComponent(params.agencyName || 'our team')
      const firstName = candidateName.split(' ')[0]

      console.log(`[WS] Session: ${candidateName} | job:${jobTitle} | callUuid:${callUuid}`)

      // Connect to Deepgram Voice Agent
      deepgramWs = new WebSocket('wss://agent.deepgram.com/agent', {
        headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` },
      })

      deepgramWs.on('open', () => {
        console.log(`[DG] Connected to Deepgram Voice Agent`)
        deepgramWs.send(JSON.stringify(buildSettings(firstName, jobTitle, agencyName)))
      })

      deepgramWs.on('message', (dgRaw) => {
        if (Buffer.isBuffer(dgRaw) || dgRaw instanceof Uint8Array) {
          // Audio from Deepgram (linear16 8kHz) → convert to mulaw → send to Plivo
          const buf = Buffer.isBuffer(dgRaw) ? dgRaw : Buffer.from(dgRaw)
          if (buf.length === 0) return
          const mulaw = linear16ToMulaw(buf)
          if (plivoWs.readyState === 1) {
            plivoWs.send(JSON.stringify({ event: 'media', media: { payload: mulaw.toString('base64') } }))
          }
        } else {
          // JSON event from Deepgram
          let event
          try { event = JSON.parse(dgRaw.toString()) } catch { return }

          console.log(`[DG] Event: ${event.type}`)

          if (event.type === 'FunctionCallRequest') {
            const fn = event.function_name || event.function_call?.name
            const args = event.input || event.function_call?.arguments || {}
            const callId = event.function_call_id || event.id

            console.log(`[DG] Function call: ${fn}`, args)

            if (fn === 'save_answers') {
              // Save answers to main platform
              saveAnswers(candidateId, args).catch(err => console.error('[DG] Save error:', err.message))

              // Send function result back to Deepgram
              deepgramWs.send(JSON.stringify({
                type: 'FunctionCallResponse',
                function_call_id: callId,
                output: 'Answers saved successfully.',
              }))
            }
          }

          if (event.type === 'AgentAudioDone' || event.type === 'ConversationText') {
            // After farewell, hang up
            if (event.type === 'ConversationText' && event.role === 'assistant') {
              const text = (event.content || '').toLowerCase()
              if (text.includes('goodbye') || text.includes('take care') || text.includes('have a great day') || text.includes('wonderful day')) {
                setTimeout(() => hangUpCall(callUuid), 3000)
              }
            }
          }
        }
      })

      deepgramWs.on('error', (err) => console.error(`[DG] Error:`, err.message))
      deepgramWs.on('close', () => console.log(`[DG] Disconnected`))
    }

    if (data.event === 'media' && deepgramWs?.readyState === 1) {
      // Audio from Plivo (mulaw 8kHz) → send as binary to Deepgram
      const mulawBuf = Buffer.from(data.media.payload, 'base64')
      deepgramWs.send(mulawBuf)
    }

    if (data.event === 'stop') {
      deepgramWs?.close()
    }
  })

  plivoWs.on('close', () => {
    console.log(`[WS] Plivo disconnected: ${peerId}`)
    deepgramWs?.close()
  })
  plivoWs.on('error', (err) => console.error(`[WS] Plivo error:`, err.message))
})

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function hangUpCall(callUuid) {
  if (!callUuid) return
  try {
    await fetch(`https://api.plivo.com/v1/Account/${PLIVO_AUTH_ID}/Call/${callUuid}/`, {
      method: 'DELETE',
      headers: { Authorization: PLIVO_AUTH_HEADER },
    })
    console.log(`[WS] Call hung up: ${callUuid}`)
  } catch (err) {
    console.error('[WS] Hangup error:', err.message)
  }
}

async function saveAnswers(candidateId, answers) {
  if (!MAIN_PLATFORM_URL || !candidateId) {
    console.log('[WS] Answers (no platform save):', answers)
    return
  }
  const res = await fetch(`${MAIN_PLATFORM_URL}/api/voice/results`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ candidateId, secret: MAIN_PLATFORM_SECRET, ...answers }),
  })
  console.log(`[WS] Answers saved: ${res.status}`)
}

// ─── Audio conversion: linear16 8kHz → mulaw 8kHz ────────────────────────────
function linear16ToMulaw(buf) {
  const samples = buf.length / 2
  const out = Buffer.alloc(samples)
  for (let i = 0; i < samples; i++) {
    const sample = buf.readInt16LE(i * 2)
    out[i] = encodeMulaw(sample)
  }
  return out
}

function encodeMulaw(sample) {
  const BIAS = 0x84
  const CLIP = 32635
  let sign = 0
  if (sample < 0) { sign = 0x80; sample = -sample }
  if (sample > CLIP) sample = CLIP
  sample += BIAS
  let exp = 7
  for (let mask = 0x4000; (sample & mask) === 0 && exp > 0; exp--, mask >>= 1) {}
  const mantissa = (sample >> (exp + 3)) & 0x0F
  return (~(sign | (exp << 4) | mantissa)) & 0xFF
}

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`[Voice Agent] Listening on port ${PORT}`)
  console.log(`  Deepgram Voice Agent bridge ready`)
})
