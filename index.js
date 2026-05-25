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
// MEMORY AI
// ======================

const memory = {}

// ======================
// TAKEOVER SYSTEM
// ======================

const aiTakeover = {}
const waitingTimer = {}

// ======================
// AI FUNCTION
// ======================

async function askAI(jid, question) {

  try {

    // memory chat
    if (!memory[jid]) {

      memory[jid] = [
        {
          role: 'system',
          content:
`Kamu adalah Gemini, asisten pribadi WhatsApp milik Repi 😄

Tugasmu:
- membantu membalas chat owner
- berbicara natural seperti manusia
- santai dan ramah
- gunakan emoji sewajarnya
- jangan terlalu formal`
        }
      ]

    }

    // simpan chat user
    memory[jid].push({
      role: 'user',
      content: question
    })

    // batas memory
    if (memory[jid].length > 20) {
      memory[jid].shift()
    }

    // request AI
    const response = await axios.post(

      'https://api.groq.com/openai/v1/chat/completions',

      {
        model: 'llama-3.3-70b-versatile',

        messages: memory[jid],

        temperature: 0.8,
        max_tokens: 1000
      },

      {
        headers: {

          Authorization:
          `Bearer ${process.env.GROQ_API_KEY}`,

          'Content-Type':
          'application/json'
        }
      }
    )

    const aiReply =
    response.data
    .choices[0]
    .message
    .content

    // simpan jawaban AI
    memory[jid].push({
      role: 'assistant',
      content: aiReply
    })

    return aiReply

  } catch (err) {

    console.log(
      err.response?.data ||
      err.message
    )

    return 'Maaf 😭 Gemini sedang error.'
  }

}

// ======================
// START BOT
// ======================

async function startBot() {

  const {
    state,
    saveCreds
  } = await useMultiFileAuthState(
    './session'
  )

  const { version } =
  await fetchLatestBaileysVersion()

  const sock = makeWASocket({

    version,

    auth: state,

    logger: P({
      level: 'silent'
    }),

    browser: [
      'Ubuntu',
      'Chrome',
      '20.0.04'
    ]

  })

  // ======================
  // SAVE SESSION
  // ======================

  sock.ev.on(
    'creds.update',
    saveCreds
  )

  // ======================
  // CONNECTION
  // ======================

  sock.ev.on(
    'connection.update',

    async (update) => {

      const {
        connection,
        lastDisconnect,
        qr
      } = update

      // ======================
      // QR CODE
      // ======================

      if (qr) {

        console.log(
          '\n===================='
        )

        console.log(
          'SCAN QR INI 😄'
        )

        console.log(
          '====================\n'
        )

        qrcode.generate(
          qr,
          {
            small: true
          }
        )

      }

      // ======================
      // CONNECTED
      // ======================

      if (connection === 'open') {

        console.log(
          '✅ Gemini Personal Assistant Online 🚀'
        )

      }

      // ======================
      // DISCONNECTED
      // ======================

      if (connection === 'close') {

        const shouldReconnect =

          lastDisconnect?.error
          ?.output?.statusCode !==
          DisconnectReason.loggedOut

        console.log(
          '❌ Koneksi terputus'
        )

        if (shouldReconnect) {

          console.log(
            '🔄 Reconnecting...'
          )

          startBot()

        }

      }

    }
  )

  // ======================
  // MESSAGE
  // ======================

  sock.ev.on(
    'messages.upsert',

    async ({ messages }) => {

      try {

        const msg = messages[0]

        if (!msg.message) return

        const jid =
        msg.key.remoteJid

        // abaikan status WA
        if (
          jid === 'status@broadcast'
        ) return

        const text =

          msg.message.conversation ||

          msg.message.extendedTextMessage
          ?.text ||

          ''

        if (!text) return

        const isFromMe =
        msg.key.fromMe

        console.log(
          'Pesan:',
          text
        )

        // ======================
        // OWNER ACTIVE
        // ======================

        if (isFromMe) {

          console.log(
            'Repi kembali 😄'
          )

          aiTakeover[jid] = false

          if (waitingTimer[jid]) {

            clearTimeout(
              waitingTimer[jid]
            )

          }

          return
        }

        // ======================
        // AI TAKEOVER
        // ======================

        if (aiTakeover[jid]) {

          console.log(
            'Gemini sedang handle chat...'
          )

          await sock.sendPresenceUpdate(
            'composing',
            jid
          )

          await delay(3000)

          const aiReply =
          await askAI(
            jid,
            text
          )

          await sock.sendMessage(
            jid,
            {
              text: aiReply
            }
          )

          await sock.sendPresenceUpdate(
            'paused',
            jid
          )

          return
        }

        // ======================
        // TIMER 30 DETIK
        // ======================

        if (waitingTimer[jid]) {

          clearTimeout(
            waitingTimer[jid]
          )

        }

        console.log(
          'Menunggu Repi 30 detik...'
        )

        waitingTimer[jid] =

        setTimeout(async () => {

          console.log(
            'Gemini takeover aktif 😄'
          )

          aiTakeover[jid] = true

          await sock.sendPresenceUpdate(
            'composing',
            jid
          )

          await delay(3000)

          const intro =
`Hai 👋
Aku Gemini asistennya Repi 😄

Silakan tunggu sebentar ya...
Repi mungkin sedang tidak memegang HP 🙏`

          await sock.sendMessage(
            jid,
            {
              text: intro
            }
          )

          await sock.sendPresenceUpdate(
            'paused',
            jid
          )

        }, 30000)

      } catch (err) {

        console.log(err)

      }

    }
  )

}

startBot()
