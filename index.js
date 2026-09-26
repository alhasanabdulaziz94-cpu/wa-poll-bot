import http from 'node:http';
import { createHash, createCipheriv, randomBytes, hkdfSync } from 'node:crypto';
import pino from 'pino';
import makeWASocket, {
  Browsers, DisconnectReason, fetchLatestBaileysVersion, generateMessageID,
  jidNormalizedUser, normalizeMessageContent, proto,
} from '@whiskeysockets/baileys';
import { useUpstashAuthState, wipeAuthState } from './authState.js';

const {
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
  ADMIN_KEY,
  PHONE_NUMBER = '',
  ALLOWED_CHATS = '',
  PORT = 3000,
  MIN_DELAY = '2',
  MAX_DELAY = '5',
  MAX_POLL_AGE = '300',
  VOTER_MODE = 'auto', // auto | pn | lid
  VOTE_LAST_N = '2',   // عدد الخيارات الأخيرة التي سيصوّت عليها
} = process.env;

if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN || !ADMIN_KEY) {
  console.error('UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN and ADMIN_KEY are required');
  process.exit(1);
}

const allowed = ALLOWED_CHATS.split(',').map((s) => s.trim()).filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randMs = (a, b) => (a + Math.random() * (b - a)) * 1000;

let status = 'starting';
let pairingCode = null;

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/pair') {
    if (url.searchParams.get('key') !== ADMIN_KEY) {
      res.writeHead(403);
      return res.end('forbidden');
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(
      `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
       <meta http-equiv="refresh" content="8">
       <body dir="rtl" style="font-family:sans-serif;text-align:center;padding:2rem">
       <h3>الحالة: ${status}</h3>
       ${pairingCode ? `<h1 style="letter-spacing:6px;direction:ltr">${pairingCode}</h1>` : ''}</body>`
    );
  }
  res.writeHead(200);
  res.end('ok');
}).listen(PORT, () => console.log('HTTP on', PORT));

function encryptVote({ secret, pollId, creator, voter, options }) {
  const selectedOptions = options.map((o) =>
    createHash('sha256').update(Buffer.from(o)).digest()
  );
  const plain = proto.Message.PollVoteMessage.encode({ selectedOptions }).finish();

  const info = Buffer.concat(
    [pollId, creator, voter, 'Poll Vote'].map((x) => Buffer.from(x))
  );
  const key = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(32), info, 32));

  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`${pollId}\u0000${voter}`));
  const encPayload = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  return { encPayload, encIv: iv };
}

process.on('unhandledRejection', (e) => console.error('unhandled:', e));

const cache = new Map();
const done = new Set();

async function handlePoll(s, m) {
  if (!m.message || m.key.fromMe) return;
  const content = normalizeMessageContent(m.message);
  const poll =
    content?.pollCreationMessage ||
    content?.pollCreationMessageV2 ||
    content?.pollCreationMessageV3;
  if (!poll) return;

  const chat = m.key.remoteJid;
  if (chat === 'status@broadcast') return;
  console.log('poll detected in chat:', chat, '| id:', m.key.id);

  cache.set(m.key.id, m.message);
  if (cache.size > 200) cache.delete(cache.keys().next().value);

  if (allowed.length && !allowed.includes(chat)) return;
  if (done.has(m.key.id)) return;
  done.add(m.key.id);

  const maxAge = Number(MAX_POLL_AGE);
  const age = Date.now() / 1000 - Number(m.messageTimestamp || 0);
  if (maxAge > 0 && age > maxAge) return console.log('old poll, skipped');

  const options = (poll.options || []).map((o) => o.optionName).filter(Boolean);
  if (!options.length) return;

  const wanted = Number(VOTE_LAST_N) || 2;
  const maxAllowed = Number(poll.selectableOptionsCount || 0);
  const n = maxAllowed > 0 ? Math.min(wanted, maxAllowed) : wanted;
  const chosen = options.slice(-n);

  const secretRaw =
    m.message.messageContextInfo?.messageSecret ||
    content.messageContextInfo?.messageSecret ||
    poll.contextInfo?.messageSecret;
  if (!secretRaw) throw new Error('poll has no messageSecret');

  const creator = jidNormalizedUser(m.key.participant || chat);
  const me = s.user || {};
  const usePN = VOTER_MODE === 'pn' || (VOTER_MODE === 'auto' && !creator.endsWith('@lid'));
  const voter = jidNormalizedUser(usePN ? me.id : me.lid || me.id);

  await sleep(randMs(Number(MIN_DELAY), Number(MAX_DELAY)));

  const { encPayload, encIv } = encryptVote({
    secret: Buffer.from(secretRaw),
    pollId: m.key.id,
    creator,
    voter,
    options: chosen,
  });

  await s.relayMessage(
    chat,
    {
      pollUpdateMessage: {
        pollCreationMessageKey: {
          remoteJid: chat,
          fromMe: false,
          id: m.key.id,
          participant: m.key.participant,
        },
        vote: { encPayload, encIv },
        senderTimestampMs: Date.now(),
      },
    },
    { messageId: generateMessageID(), additionalNodes: [{ tag: 'meta', attrs: { polltype: 'vote' } }] }
  );
  console.log(`voted "${chosen.join(' | ')}" | creator=${creator} voter=${voter}`);
}

async function start() {
  const { state, saveCreds } = await useUpstashAuthState(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN);
  let version;
  try { ({ version } = await fetchLatestBaileysVersion()); } catch {}

  let asked = false;
  const s = makeWASocket({
    ...(version && { version }),
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    getMessage: async (key) => cache.get(key.id),
  });

  s.ev.on('creds.update', saveCreds);

  s.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr && !state.creds.registered && PHONE_NUMBER && !asked) {
      asked = true;
      try {
        pairingCode = await s.requestPairingCode(PHONE_NUMBER.replace(/\D/g, ''));
        status = 'waiting_for_pairing';
        console.log('PAIRING CODE:', pairingCode);
      } catch (e) {
        asked = false;
        console.error('pairing error:', e.message);
      }
    }
    if (connection === 'open') {
      status = 'connected';
      pairingCode = null;
      console.log('connected as', s.user?.id);
    }
    if (connection === 'close') {
      status = 'disconnected';
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log('closed, code =', code);
      if (code === DisconnectReason.loggedOut) {
        await wipeAuthState(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN);
        console.log('logged out: session wiped, re-pairing fresh');
        return setTimeout(start, 5000);
      }
      const wait = code === DisconnectReason.connectionReplaced ? 60000 : 3000;
      setTimeout(start, wait);
    }
  });

  s.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) {
      handlePoll(s, m).catch((e) => console.error('vote error:', e?.message || e));
    }
  });
}

start();
