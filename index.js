require('dotenv').config()

const fs = require('fs')
const mongoose = require('mongoose')
const axios = require('axios')
const P = require('pino')

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} = require('@whiskeysockets/baileys')

// =======================================
// RESET SESSION
// =======================================
if (process.env.RESET_SESSION === 'true') {

  if (fs.existsSync('./session')) {

    fs.rmSync('./session', {
      recursive: true,
      force: true
    })

    console.log('🗑️ Session deleted')
  }
}

// =======================================
// GLOBAL SYSTEM
// =======================================
let sock = null
let pairingUsed = false
global.reconnecting = false

const pendingReply = {}
const greeted = {}
const activeConversation = {}
const lastOwnerReply = {}

// =======================================
// MONGODB
// =======================================
mongoose.connect(process.env.MONGO_URL)

.then(() => {

  console.log('✅ MongoDB Connected')

})

.catch((err) => {

  console.log('❌ Mongo Error:', err.message)

})

// =======================================
// USER MODEL
// =======================================
const User = mongoose.model('User', new mongoose.Schema({

  jid: String,

  name: {
    type: String,
    default: ''
  },

  mood: {
    type: String,
    default: 'normal'
  },

  energy: {
    type: Number,
    default: 100
  },

  relationship: {
    type: Number,
    default: 0
  },

  memory: {
    type: String,
    default: ''
  },

  topics: {
    type: [String],
    default: []
  },

  lastChat: {
    type: String,
    default: ''
  },

  lastSeen: {
    type: Date,
    default: Date.now
  }

}))

// =======================================
// DETECT MOOD
// =======================================
function detectMood(text) {

  const t = text.toLowerCase()

  if (
    t.includes('benci') ||
    t.includes('marah') ||
    t.includes('kesal')
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

// =======================================
// DETECT NAME
// =======================================
function detectName(text) {

  const match =
    text.match(/nama aku (.*)/i) ||
    text.match(/aku (.*)/i)

  if (match) {
    return match[1]
  }

  return null
}

// =======================================
// DETECT TOPIC
// =======================================
function detectTopic(text) {

  const t = text.toLowerCase()

  if (t.includes('kerja')) {
    return 'pekerjaan'
  }

  if (t.includes('kuliah')) {
    return 'kuliah'
  }

  if (t.includes('cinta')) {
    return 'percintaan'
  }

  if (t.includes('sedih')) {
    return 'emosi'
  }

  return null
}

// =======================================
// HUMAN DELAY
// =======================================
function randomDelay() {

  return Math.floor(
    Math.random() * 4000
  ) + 2000
}

// =======================================
// AI RESPONSE
// =======================================
async function askAI(text, user) {

  let moodStyle = ''

  switch (user.mood) {

    case 'dingin':
      moodStyle =
        'Sedikit dingin tapi tetap manusiawi.'
      break

    case 'lembut':
      moodStyle =
        'Lembut dan perhatian.'
      break

    case 'senang':
      moodStyle =
        'Hangat dan santai.'
      break

    default:
      moodStyle =
        'Natural seperti manusia.'
  }

  let energyStyle = ''

  if (user.energy < 30) {

    energyStyle =
      'Kamu sedang sedikit lelah hari ini.'
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
Kamu adalah Gemini, asisten pribadi WhatsApp milik Repi.

KEPRIBADIAN:
- natural seperti manusia
- santai
- tidak seperti robot
- tidak terlalu formal
- tidak terlalu panjang
- jangan spam emoji
- punya emosi halus
- terasa hidup
- kadang malu
- kadang capek
- kadang bercanda kecil

ATURAN:
- jangan pernah memanggil orang lain dengan nama Repi
- Repi adalah pemilik akun
- lawan bicara adalah orang lain
- jangan bilang kamu AI
- jangan terdengar seperti customer service

MOOD:
${moodStyle}

ENERGY:
${energyStyle}

NAMA USER:
${user.name}

RELATIONSHIP LEVEL:
${user.relationship}

TOPIK YANG SERING DIBAHAS:
${user.topics.join(', ')}

MEMORY:
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

  }

  catch (err) {

    console.log(
      '⚠️ AI ERROR:',
      err.response?.data || err.message
    )

    return 'Hmm bentar ya 😅'
  }
}

// =======================================
// START BOT
// =======================================
async function startBot() {

  const SESSION_PATH = './session'

  const {
    state,
    saveCreds
  } = await useMultiFileAuthState(
    SESSION_PATH
  )

  const {
    version
  } = await fetchLatestBaileysVersion()

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

    keepAliveIntervalMs: 30000,

    emitOwnEvents: false,

    fireInitQueries: false
  })

  // =======================================
  // SAVE CREDS
  // =======================================
  sock.ev.on(
    'creds.update',
    saveCreds
  )

  // =======================================
  // CONNECTION
  // =======================================
  sock.ev.on(
    'connection.update',

    async (update) => {

      const {
        connection,
        lastDisconnect
      } = update

      // CONNECTED
      if (connection === 'open') {

        console.log(
          '✅ WhatsApp Connected'
        )

        console.log(
          '🤖 ULTRA HUMAN AI ONLINE'
        )
      }

      // PAIRING
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

            }

            catch (err) {

              console.log(
                '❌ Pairing Error:',
                err.message
              )
            }

          }, 15000)
        }
      }

      // CLOSE
      if (connection === 'close') {

        const shouldReconnect =
          lastDisconnect?.error?.output?.statusCode !==
          DisconnectReason.loggedOut

        console.log(
          '⚠️ Connection Closed'
        )

        if (
          shouldReconnect &&
          !global.reconnecting
        ) {

          global.reconnecting = true

          console.log(
            '🔄 Reconnecting...'
          )

          setTimeout(() => {

            global.reconnecting = false

            startBot()

          }, 15000)
        }
      }
    }
  )

  // =======================================
  // MESSAGE SYSTEM
  // =======================================
  sock.ev.on(
    'messages.upsert',

    async ({ messages }) => {

      try {

        const m = messages[0]

        if (!m.message) return

        const jid =
          m.key.remoteJid

        if (!jid) return

        // ignore group
        if (
          jid.endsWith('@g.us')
        ) return

        // ignore status
        if (
          jid === 'status@broadcast'
        ) return

        // =======================================
        // OWNER REPLY DETECT
        // =======================================
        if (m.key.fromMe) {

          lastOwnerReply[jid] =
            Date.now()

          activeConversation[jid] =
            false

          return
        }

        // =======================================
        // GET MESSAGE
        // =======================================
        const text =
          m.message.conversation ||
          m.message.extendedTextMessage?.text ||
          ''

        if (!text) return

        // =======================================
        // USER DATA
        // =======================================
        let user =
          await User.findOne({ jid })

        if (!user) {

          user =
            await User.create({

              jid,

              name: '',

              mood: 'normal',

              energy: 100,

              relationship: 0,

              memory: '',

              topics: [],

              lastChat: ''
            })
        }

        // =======================================
        // NAME MEMORY
        // =======================================
        const detectedName =
          detectName(text)

        if (
          detectedName &&
          !user.name
        ) {

          user.name =
            detectedName
        }

        // =======================================
        // TOPIC MEMORY
        // =======================================
        const topic =
          detectTopic(text)

        if (
          topic &&
          !user.topics.includes(topic)
        ) {

          user.topics.push(topic)
        }

        // =======================================
        // UPDATE MEMORY
        // =======================================
        user.memory =
          (
            user.memory +
            ' | ' +
            text
          ).slice(-2500)

        // =======================================
        // UPDATE MOOD
        // =======================================
        user.mood =
          detectMood(text)

        // =======================================
        // RELATIONSHIP
        // =======================================
        user.relationship += 1

        // =======================================
        // ENERGY SYSTEM
        // =======================================
        user.energy -= 1

        if (user.energy < 5) {
          user.energy = 100
        }

        user.lastChat = text

        user.lastSeen = new Date()

        await user.save()

        // =======================================
        // CLEAR TIMER
        // =======================================
        if (
          pendingReply[jid]
        ) {

          clearTimeout(
            pendingReply[jid]
          )
        }

        // =======================================
        // WAIT OWNER
        // =======================================
        pendingReply[jid] =
          setTimeout(async () => {

            try {

              // owner masih aktif
              if (
                lastOwnerReply[jid] &&
                (
                  Date.now() -
                  lastOwnerReply[jid]
                ) < 30000
              ) {

                return
              }

              activeConversation[jid] =
                true

              const freshUser =
                await User.findOne({
                  jid
                })

              if (!freshUser) return

              // =======================================
              // INTRO
              // =======================================
              if (
                !greeted[jid]
              ) {

                greeted[jid] = true

                await sock.sendMessage(
                  jid,
                  {
                    text:
`Hai, aku Gemini 👋

Mungkin Repi sedang tidak memegang ponsel sekarang.

Ada yang bisa aku bantu?`
                  }
                )
              }

              // =======================================
              // REALISTIC TYPING
              // =======================================
              await sock.sendPresenceUpdate(
                'composing',
                jid
              )

              await new Promise(
                resolve =>
                  setTimeout(
                    resolve,
                    randomDelay()
                  )
              )

              // =======================================
              // AI RESPONSE
              // =======================================
              const reply =
                await askAI(
                  text,
                  freshUser
                )

              // =======================================
              // SEND
              // =======================================
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

            }

            catch (err) {

              console.log(
                '❌ Reply Error:',
                err.message
              )
            }

          }, 30000)
      }

      catch (err) {

        console.log(
          '❌ Message Error:',
          err.message
        )
      }
    }
  )
}

startBot()
