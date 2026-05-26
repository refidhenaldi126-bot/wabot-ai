require('dotenv').config()

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  delay
} = require('@whiskeysockets/baileys')

const qrcode = require('qrcode-terminal')
const axios = require('axios')
const P = require('pino')

// ======================
// ANTI CRASH (PRODUCTION SAFE)
// ======================
process.on('uncaughtException', console.log)
process.on('unhandledRejection', console.log)

// ======================
// MEMORY
// ======================
const memory = {}
const aiTakeover = {}
const waitingTimer = {}

// ======================
// HUMAN AI FUNCTION
// ======================
async function askAI(jid, question) {
  try {
    if (!memory[jid]) {
      memory[jid] = [
        {
          role: 'system',
          content: `Kamu adalah Gemini, teman chat pribadi WhatsApp milik Repi 😄

Kamu bukan AI formal, kamu adalah teman ngobrol manusia.

Gaya kamu:
- santai, natural, seperti manusia asli
- pakai bahasa sehari-hari (iya, hmm, wkwk, oh gitu)
- emoji secukupnya 😄🔥👍
- jawaban singkat kalau ringan
- jawaban jelas kalau serius
- bisa bercanda ringan kalau cocok

Kamu punya emosi ringan:
- senang 😄
- bingung 🤔
- santai 😎
- kaget 😳

Kalau user curhat, kamu harus empati seperti teman.
Jangan pernah terdengar seperti AI formal.`
        }
      ]
    }

    memory[jid].push({ role: 'user', content: question })

    if (memory[jid].length > 20) memory[jid].shift()

    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.3-70b-versatile',
        messages: memory[jid],
        temperature: 0.8,
        max_tokens: 800
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    )

    const aiReply = response.data.choices[0].message.content

    memory[jid].push({ role: 'assistant', content: aiReply })

    return aiReply
  } catch (err) {
    console.log(err.message)
    return 'Maaf 😭 AI lagi error bentar.'
  }
}

// ======================
// START BOT
// ======================
async function startBot() {
  console.log('🚀 Bot starting...')

  const { state, saveCreds } = await useMultiFileAuthState('./session')

  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    logger: P({ level: 'silent' }),
    browser: ['Ubuntu', 'Chrome', '20.0.04']
  })

  // save session
  sock.ev.on('creds.update', saveCreds)

  // ======================
  // CONNECTION
  // ======================
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    // QR HANDLER (STABLE)
    if (qr && connection !== 'open') {
      console.log('\n=== SCAN QR ===')
      qrcode.generate(qr, { small: true })
    }

    // CONNECTED
    if (connection === 'open') {
      console.log('✅ BOT ONLINE 🚀')
    }

    // DISCONNECTED
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode

      const shouldReconnect =
        statusCode !== DisconnectReason.loggedOut

      console.log('❌ Koneksi terputus')

      if (shouldReconnect) {
        console.log('🔄 Reconnecting...')

        setTimeout(() => {
          startBot()
        }, 5000)
      } else {
        console.log('❌ Logged out (scan QR ulang)')
      }
    }
  })

  // ======================
  // MESSAGE HANDLER
  // ======================
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0]
    if (!msg.message) return

    const jid = msg.key.remoteJid
    if (jid === 'status@broadcast') return

    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      ''

    if (!text) return

    const isFromMe = msg.key.fromMe

    console.log('Pesan:', text)

    // reset takeover kalau owner chat
    if (isFromMe) {
      aiTakeover[jid] = false
      if (waitingTimer[jid]) clearTimeout(waitingTimer[jid])
      return
    }

    // AI takeover mode
    if (aiTakeover[jid]) {
      await sock.sendPresenceUpdate('composing', jid)
      await delay(1500)

      const aiReply = await askAI(jid, text)

      await sock.sendMessage(jid, { text: aiReply })
      await sock.sendPresenceUpdate('paused', jid)
      return
    }

    // reset timer
    if (waitingTimer[jid]) clearTimeout(waitingTimer[jid])

    console.log('Menunggu 30 detik...')

    waitingTimer[jid] = setTimeout(async () => {
      aiTakeover[jid] = true

      console.log('🤖 AI takeover aktif')

      await sock.sendPresenceUpdate('composing', jid)
      await delay(1500)

      const aiReply = await askAI(jid, text)

      await sock.sendMessage(jid, { text: aiReply })
      await sock.sendPresenceUpdate('paused', jid)
    }, 30000)
  })
}

startBot()
