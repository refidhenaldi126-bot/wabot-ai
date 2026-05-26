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

  name: {
    type: String,
    default: 'User'
  },

  memory: {
    type: String,
    default: ''
  },

  mood: {
    type: String,
    default: 'normal'
  },

  lastActive: Number

}))

// ======================
// GLOBAL STATE
// ======================
const pendingReply = {}
const greeted = {}

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

  let style = ''

  switch (user.mood) {

    case 'dingin':
      style =
        'Balas lebih dingin tapi tetap sopan'
      break

    case 'lembut':
      style =
        'Balas lebih perhatian dan lembut'
      break

    case 'senang':
      style =
        'Balas lebih hangat dan santai'
      break

    default:
      style =
        'Balas santai seperti manusia biasa'
  }

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
- jangan terdengar seperti robot
- jangan terlalu formal
- jawab natural seperti manusia
- gunakan bahasa santai Indonesia
- jangan terlalu panjang
- jangan gunakan emoji berlebihan

STYLE:
${style}

MEMORY USER:
${user.memory}
`
          },
          {
            role: 'user',
            content: text
          }
        ],

        temperature: 0.9,
        max_tokens: 250
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

  const {
    state,
    saveCreds
  } = await useMultiFileAuthState(
    '/app/session'
  )

  const {
    version
  } = await fetchLatestBaileysVersion()

  // ======================
  // CREATE SOCKET
  // ======================
  const sock = makeWASocket({

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
      // OPEN
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

        setTimeout(async () => {

          try {

            if (
              !sock.authState.creds.registered
            ) {

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
            }

          } catch (err) {

            console.log(
              '❌ Pairing Error:',
              err.message
            )
          }

        }, 20000)
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
            '🔄 Restarting Bot...'
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

        // ignore own message
        if (m.key.fromMe) return

        // ======================
        // GET MESSAGE
        // ======================
        const text =
          m.message.conversation ||
          m.message.extendedTextMessage?.text ||
          ''

        if (!text) return

        const now = Date.now()

        // ======================
        // LOAD USER
        // ======================
        let user =
          await User.findOne({ jid })

        if (!user) {

          user =
            await User.create({

              jid,

              name:
                m.pushName || 'User',

              memory: '',

              mood: 'normal',

              lastActive: now
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

        user.lastActive = now

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

        const lastText = text

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
              // INTRO
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
              // TYPING EFFECT
              // ======================
              await sock.sendPresenceUpdate(
                'composing',
                jid
              )

              await new Promise(
                resolve =>
                  setTimeout(
                    resolve,
                    2000
                  )
              )

              // ======================
              // AI REPLY
              // ======================
              const reply =
                await askAI(
                  lastText,
                  freshUser
                )

              // ======================
              // SEND REPLY
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

              delete pendingReply[jid]

            } catch (err) {

              console.log(
                '❌ Reply Error:',
                err.message
              )
            }

          }, 30000)

      } catch (err) {

        console.log(
          '❌ Message Error:',
          err.message
        )
      }
    }
  )
}

startBot()
