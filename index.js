require('dotenv').config()

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} = require('@whiskeysockets/baileys')

const mongoose = require('mongoose')
const axios = require('axios')
const P = require('pino')

// ======================
// GLOBAL
// ======================
let sock = null
let pairingUsed = false

const pendingReply = {}
const greeted = {}

// ======================
// CONNECT MONGODB
// ======================
mongoose.connect(process.env.MONGO_URL)
  .then(() => {
    console.log('✅ MongoDB Connected')
  })
  .catch(err => {
    console.log('❌ Mongo Error:', err.message)
  })

// ======================
// USER MODEL
// ======================
const User = mongoose.model('User', new mongoose.Schema({

  jid: String,

  memory: {
    type: String,
    default: ''
  },

  mood: {
    type: String,
    default: 'normal'
  }

}))

// ======================
// DETECT MOOD
// ======================
function detectMood(text) {

  const t = text.toLowerCase()

  if (
    t.includes('marah') ||
    t.includes('kesal') ||
    t.includes('benci')
  ) {
    return 'dingin'
  }

  if (
    t.includes('sedih') ||
    t.includes('capek')
  ) {
    return 'lembut'
  }

  if (
    t.includes('makasih') ||
    t.includes('terima kasih')
  ) {
    return 'senang'
  }

  return 'normal'
}

// ======================
// AI FUNCTION
// ======================
async function askAI(text, user) {

  try {

    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',

      {
        model: 'llama-3.1-8b-instant',

        messages: [

          {
            role: 'system',

            content: `
Kamu adalah asisten pribadi WhatsApp.

ATURAN:
- bicara natural seperti manusia
- jangan seperti robot
- jangan terlalu formal
- gunakan bahasa santai Indonesia
- jangan terlalu panjang
- jangan spam emoji

Mood user:
${user.mood}

Memory user:
${user.memory}
`
          },

          {
            role: 'user',
            content: text
          }
        ],

        temperature: 0.8,

        max_tokens: 200
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

    return response.data
      .choices[0]
      .message
      .content

  } catch (err) {

    console.log(
      '⚠️ AI ERROR:',
      err.response?.data || err.message
    )

    return 'Maaf, aku lagi error sebentar.'
  }
}

// ======================
// START BOT
// ======================
async function startBot() {

  // ======================
  // AUTO SESSION PATH
  // ======================
  const SESSION_PATH =
    process.env.RAILWAY_ENVIRONMENT
      ? '/app/session'
      : './session'

  // ======================
  // AUTH
  // ======================
  const {
    state,
    saveCreds
  } = await useMultiFileAuthState(
    SESSION_PATH
  )

  // ======================
  // VERSION
  // ======================
  const {
    version
  } = await fetchLatestBaileysVersion()

  // ======================
  // CREATE SOCKET
  // ======================
  sock = makeWASocket({

    version,

    auth: state,

    printQRInTerminal: false,

    logger: P({
      level: 'silent'
    }),

    browser: [
      'Ubuntu',
      'Chrome',
      '22.04.4'
    ],

    syncFullHistory: false,

    markOnlineOnConnect: false,

    generateHighQualityLinkPreview: false,

    connectTimeoutMs: 60000,

    defaultQueryTimeoutMs: 60000,

    keepAliveIntervalMs: 10000
  })

  // ======================
  // SAVE SESSION
  // ======================
  sock.ev.on(
    'creds.update',
    saveCreds
  )

  // ======================
  // CONNECTION UPDATE
  // ======================
  sock.ev.on(
    'connection.update',
    async (update) => {

      const {
        connection,
        lastDisconnect
      } = update

      // ======================
      // CONNECTED
      // ======================
      if (connection === 'open') {

        console.log(
          '🤖 PERSONAL ASSISTANT ONLINE'
        )
      }

      // ======================
      // PAIRING SYSTEM
      // ======================
      if (
        connection === 'connecting'
      ) {

        if (
          !state.creds.registered &&
          !pairingUsed
        ) {

          pairingUsed = true

          setTimeout(async () => {

            try {

              const code =
                await sock.requestPairingCode(
                  process.env.PHONE_NUMBER
                )

              console.log(`
╔════════════════════╗
     PAIRING CODE

     ${code}

╚════════════════════╝
`)

            } catch (err) {

              console.log(
                '❌ Pairing Error:',
                err.message
              )
            }

          }, 15000)
        }
      }

      // ======================
      // CONNECTION CLOSED
      // ======================
      if (connection === 'close') {

        const shouldReconnect =
          lastDisconnect?.error?.output?.statusCode !==
          DisconnectReason.loggedOut

        console.log(
          '⚠️ Connection Closed'
        )

        if (shouldReconnect) {

          console.log(
            '🔄 Reconnecting...'
          )

          setTimeout(() => {
            startBot()
          }, 10000)
        }
      }
    }
  )

  // ======================
  // MESSAGE HANDLER
  // ======================
  sock.ev.on(
    'messages.upsert',
    async ({ messages }) => {

      try {

        const m = messages[0]

        if (!m.message) return

        if (m.key.fromMe) return

        const jid =
          m.key.remoteJid

        // ignore group
        if (
          jid.endsWith('@g.us')
        ) return

        // ignore status
        if (
          jid === 'status@broadcast'
        ) return

        // ======================
        // GET MESSAGE
        // ======================
        const text =
          m.message.conversation ||
          m.message.extendedTextMessage?.text ||
          ''

        if (!text) return

        // ======================
        // LOAD USER
        // ======================
        let user =
          await User.findOne({ jid })

        if (!user) {

          user =
            await User.create({

              jid,

              memory: '',

              mood: 'normal'
            })
        }

        // ======================
        // UPDATE MEMORY
        // ======================
        user.memory =
          (
            user.memory +
            ' | ' +
            text
          ).slice(-1500)

        // ======================
        // UPDATE MOOD
        // ======================
        user.mood =
          detectMood(text)

        await user.save()

        // ======================
        // RESET TIMER
        // ======================
        if (
          pendingReply[jid]
        ) {

          clearTimeout(
            pendingReply[jid]
          )
        }

        // ======================
        // WAIT 30 DETIK
        // ======================
        pendingReply[jid] =
          setTimeout(async () => {

            try {

              const freshUser =
                await User.findOne({
                  jid
                })

              if (!freshUser) return

              // ======================
              // INTRO SEKALI
              // ======================
              if (
                !greeted[jid]
              ) {

                greeted[jid] = true

                await sock.sendMessage(
                  jid,
                  {
                    text:
`Hai 👋
Mungkin Repi sedang tidak memegang HP.

Ada yang bisa aku bantu?`
                  }
                )
              }

              // ======================
              // TYPING
              // ======================
              await sock.sendPresenceUpdate(
                'composing',
                jid
              )

              // ======================
              // AI REPLY
              // ======================
              const reply =
                await askAI(
                  text,
                  freshUser
                )

              // ======================
              // SEND MESSAGE
              // ======================
              await sock.sendMessage(
                jid,
                {
                  text: reply
                }
              )

              await sock.sendPresenceUpdate(
                'paused',
                jid
              )

            } catch (err) {

              console.log(
                '❌ Reply Error:',
                err.message
              )
            }

          }, 30000)
      }

      catch (err) {

        console.log(
          '❌ Message Handler Error:',
          err.message
        )
      }
    }
  )
}

startBot()
