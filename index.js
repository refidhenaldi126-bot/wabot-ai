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

let sock = null
let pairingUsed = false

// ======================
// CONNECT DATABASE
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
// MEMORY
// ======================
const pendingReply = {}
const greeted = {}

// ======================
// MOOD
// ======================
function detectMood(text) {

  const t = text.toLowerCase()

  if (
    t.includes('marah') ||
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

  return 'normal'
}

// ======================
// AI
// ======================
async function askAI(text, user) {

  try {

    const res = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.1-8b-instant',

        messages: [
          {
            role: 'system',
            content: `
Kamu adalah asisten pribadi WhatsApp.
Balas natural seperti manusia.
Jangan seperti robot.
Gunakan bahasa santai Indonesia.

Mood:
${user.mood}

Memory:
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
            `Bearer ${process.env.GROQ_API_KEY}`
        }
      }
    )

    return res.data
      .choices[0]
      .message
      .content

  } catch (err) {

    console.log(
      '⚠️ AI ERROR'
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

  sock = makeWASocket({

    version,

    auth: state,

    logger: P({
      level: 'silent'
    }),

    printQRInTerminal: false,

    browser: [
      'Ubuntu',
      'Chrome',
      '22.04.4'
    ],

    connectTimeoutMs: 60000,

    keepAliveIntervalMs: 10000,

    markOnlineOnConnect: false,

    syncFullHistory: false
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
          '✅ WhatsApp Connected'
        )
      }

      // ======================
      // PAIRING
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
                '❌ Pairing Failed'
              )
            }

          }, 15000)
        }
      }

      // ======================
      // CLOSE
      // ======================
      if (connection === 'close') {

        const reason =
          lastDisconnect?.error?.output
            ?.statusCode

        console.log(
          '⚠️ Connection Closed'
        )

        if (
          reason !==
          DisconnectReason.loggedOut
        ) {

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
  // MESSAGE
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

        if (
          jid.endsWith('@g.us')
        ) return

        const text =
          m.message.conversation ||
          m.message.extendedTextMessage?.text ||
          ''

        if (!text) return

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

        user.memory =
          (
            user.memory +
            ' | ' +
            text
          ).slice(-1000)

        user.mood =
          detectMood(text)

        await user.save()

        // reset timer
        if (
          pendingReply[jid]
        ) {

          clearTimeout(
            pendingReply[jid]
          )
        }

        // wait 30s
        pendingReply[jid] =
          setTimeout(async () => {

            try {

              const fresh =
                await User.findOne({
                  jid
                })

              // intro sekali
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

              await sock.sendPresenceUpdate(
                'composing',
                jid
              )

              const reply =
                await askAI(
                  text,
                  fresh
                )

              await sock.sendMessage(
                jid,
                {
                  text: reply
                }
              )

            } catch (err) {

              console.log(
                '❌ Reply Error'
              )
            }

          }, 30000)
      }

      catch (err) {

        console.log(
          '❌ Message Handler Error'
        )
      }
    }
  )
}

startBot()
