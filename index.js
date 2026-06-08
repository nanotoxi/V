import http from 'http'
import Groq from 'groq-sdk'

const PORT = process.env.PORT || 3001
const GROQ_API_KEY = process.env.GROQ_API_KEY
const MAIN_PLATFORM_URL = process.env.MAIN_PLATFORM_URL
const MAIN_PLATFORM_SECRET = process.env.MAIN_PLATFORM_SECRET
const PLIVO_AUTH_ID = process.env.PLIVO_AUTH_ID || 'MAMTNIM2UZZJUTYZY0ZI'
const PLIVO_AUTH_TOKEN = process.env.PLIVO_AUTH_TOKEN || 'MDY5NGY3NTUtNTBiZC00ZDk5LTc2NzItYzczNGI5'
const AGENT_URL = process.env.AGENT_URL || `http://localhost:${PORT}`

const QUESTIONS = [
  { field: 'noticePeriod',   col: 'voice_notice_period',    ask: 'What is your current notice period?' },
  { field: 'currentCtc',     col: 'voice_current_ctc',      ask: 'What is your current CTC — your annual salary in lakhs?' },
  { field: 'expectedCtc',    col: 'voice_expected_ctc',      ask: 'What salary are you targeting in your next role?' },
  { field: 'activelyLooking',col: 'voice_actively_looking',  ask: 'Are you actively looking for a new job, or just exploring options?' },
]
const ACKS = ['Got it.', 'Sure.', 'Noted.', 'Perfect.']

// ─── Helpers ──────────────────────────────────────────────────────────────────
function parseBody(req) {
  return new Promise(resolve => {
    let body = ''
    req.on('data', d => body += d)
    req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(body))))
  })
}

function xml(res, content) {
  res.writeHead(200, { 'Content-Type': 'application/xml' })
  res.end(`<?xml version="1.0" encoding="UTF-8"?><Response>${content}</Response>`)
}

function speak(text) {
  return `<Speak voice="WOMAN" language="en-IN">${text}</Speak>`
}

function record(actionUrl) {
  return `<Record action="${actionUrl.replace(/&/g, '&amp;')}" method="POST" maxLength="25" timeout="1" playBeep="false" />`
}

// ─── HTTP server ──────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200); res.end('Zynq Voice Agent OK'); return
  }

  // ── /answer — Plivo calls this when candidate picks up ──────────────────────
  if (req.method === 'POST' && url.pathname === '/answer') {
    const candidateId   = url.searchParams.get('candidateId') || ''
    const candidateName = decodeURIComponent(url.searchParams.get('candidateName') || 'there')
    const jobTitle      = decodeURIComponent(url.searchParams.get('jobTitle') || 'this role')
    const agencyName    = decodeURIComponent(url.searchParams.get('agencyName') || 'our team')
    const firstName     = candidateName.split(' ')[0]

    console.log(`[answer] ${candidateName} | ${jobTitle}`)

    const transcribeUrl = `${AGENT_URL}/transcribe?candidateId=${candidateId}&questionIndex=0` +
      `&candidateName=${encodeURIComponent(candidateName)}&jobTitle=${encodeURIComponent(jobTitle)}&agencyName=${encodeURIComponent(agencyName)}`

    xml(res,
      speak(`Hi ${firstName}, this is a call from ${agencyName} about your application for ${jobTitle}. I have 4 quick questions.`) +
      speak(QUESTIONS[0].ask) +
      record(transcribeUrl)
    )
    return
  }

  // ── /transcribe — called after each recording ────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/transcribe') {
    const body          = await parseBody(req)
    const candidateId   = url.searchParams.get('candidateId') || ''
    const questionIndex = parseInt(url.searchParams.get('questionIndex') || '0')
    const candidateName = decodeURIComponent(url.searchParams.get('candidateName') || 'there')
    const jobTitle      = decodeURIComponent(url.searchParams.get('jobTitle') || 'this role')
    const agencyName    = decodeURIComponent(url.searchParams.get('agencyName') || 'our team')
    const firstName     = candidateName.split(' ')[0]
    const recordingUrl  = body.RecordUrl || body.RecordingUrl || body.recording_url || ''

    console.log(`[transcribe] Q${questionIndex} recordingUrl:${recordingUrl ? 'yes' : 'no'}`)

    // Transcribe with Groq Whisper
    let transcript = 'no_response'
    if (recordingUrl) {
      try {
        const groq = new Groq({ apiKey: GROQ_API_KEY })
        const audioRes = await fetch(recordingUrl, {
          headers: { Authorization: 'Basic ' + Buffer.from(`${PLIVO_AUTH_ID}:${PLIVO_AUTH_TOKEN}`).toString('base64') }
        })
        const audioFile = new File([Buffer.from(await audioRes.arrayBuffer())], 'rec.mp3', { type: 'audio/mpeg' })
        const result = await groq.audio.transcriptions.create({ file: audioFile, model: 'whisper-large-v3', language: 'en' })
        transcript = result.text.trim() || 'no_response'
        console.log(`[transcribe] Q${questionIndex}: "${transcript}"`)
      } catch (err) {
        console.error('[transcribe] error:', err.message)
      }
    }

    // Save to main platform
    const q = QUESTIONS[questionIndex]
    if (q && candidateId) {
      saveAnswer(candidateId, q.field, transcript).catch(err => console.error('[save]', err.message))
    }

    const nextIndex = questionIndex + 1

    // Last question answered — thank and hang up
    if (nextIndex >= QUESTIONS.length) {
      xml(res,
        speak(`Thank you ${firstName}, that is everything we needed. The team at ${agencyName} will be in touch within 2 business days. Have a great day!`) +
        `<Hangup />`
      )
      return
    }

    // Next question
    const transcribeUrl = `${AGENT_URL}/transcribe?candidateId=${candidateId}&questionIndex=${nextIndex}` +
      `&candidateName=${encodeURIComponent(candidateName)}&jobTitle=${encodeURIComponent(jobTitle)}&agencyName=${encodeURIComponent(agencyName)}`

    xml(res,
      speak(`${ACKS[questionIndex % ACKS.length]} ${QUESTIONS[nextIndex].ask}`) +
      record(transcribeUrl)
    )
    return
  }

  // ── /hangup ──────────────────────────────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/hangup') {
    const body = await parseBody(req)
    console.log(`[hangup] ${body.CallUUID} ${body.Duration}s ${body.HangupCause}`)
    res.writeHead(200); res.end()
    return
  }

  res.writeHead(404); res.end()
})

// ─── Save answer ──────────────────────────────────────────────────────────────
async function saveAnswer(candidateId, field, value) {
  if (!MAIN_PLATFORM_URL) return
  const fieldMap = {
    noticePeriod: 'noticePeriod', currentCtc: 'currentCtc',
    expectedCtc: 'expectedCtc', activelyLooking: 'activelyLooking'
  }
  await fetch(`${MAIN_PLATFORM_URL}/api/voice/results`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ candidateId, secret: MAIN_PLATFORM_SECRET, [fieldMap[field]]: value }),
  })
}

server.listen(PORT, () => console.log(`[Voice Agent] Ready on port ${PORT}`))
