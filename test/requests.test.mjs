import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHost } from '../lib/host.js'
import { CHAT, OWNER, fakeHost, makeBridge, settle, topicMessage } from './harness.mjs'
import { createFakeDsh } from './fake-dsh.mjs'

async function env0(t, options) {
  const env = await makeBridge(options)
  t.after(env.close)
  await env.store.putTopic('session-a', { chatId: CHAT, threadId: 300, name: 'ws · t', closed: false })
  return env
}

const from = { id: OWNER, is_bot: false, first_name: 'Owner', username: 'owner_tg' }

test('approval prompt and Done line mention the Telegram user who sent the request', async (t) => {
  const env = await env0(t)
  await env.bridge.handleUpdate(topicMessage(300, 'deploy it', { from }))
  await settle(env, 'session-a')
  assert.equal(env.store.topic('session-a').requesterId, OWNER)
  const handle = await env.bridge.requestApproval('session-a', { toolName: 'bash', reason: 'push' })
  const prompt = env.tg.callsOf('sendMessage').find((call) => /Approval needed/.test(call.params.text))
  assert.match(prompt.params.text, /\n@owner_tg$/)
  handle.settle('allowed-once', 'answered in Telegram')
  env.bridge.onTurnStarted('session-a')
  env.bridge.onTurnEnded('session-a', { reason: 'completed' })
  await settle(env, 'session-a')
  const done = env.tg.callsOf('sendMessage').find((call) => /✅ Done/.test(call.params.text))
  assert.match(done.params.text, /^✅ Done · \d+s\n@owner_tg$/)
  assert.equal(done.params.disable_notification, false)
})

test('a request typed in DSH mentions the first allowed user by link', async (t) => {
  const env = await env0(t)
  await env.bridge.handleUpdate(topicMessage(300, 'from telegram'))
  await settle(env, 'session-a')
  env.bridge.onUserMessage('session-a', { text: 'from the GUI', source: { kind: 'user' } })
  await settle(env, 'session-a')
  assert.equal(env.store.topic('session-a').requesterId, undefined)
  await env.bridge.requestApproval('session-a', { toolName: 'bash' })
  const prompt = env.tg.callsOf('sendMessage').find((call) => /Approval needed/.test(call.params.text))
  assert.match(prompt.params.text, new RegExp(`<a href="tg://user\\?id=${OWNER}">Owner</a>$`))
})

test('an unknown user is looked up with getChatMember once and remembered', async (t) => {
  const env = await env0(t)
  env.tg.members.set(OWNER, { first_name: 'Ivan', username: 'ivan_tg' })
  await env.bridge.requestApproval('session-a', { toolName: 'bash' })
  await env.bridge.requestApproval('session-a', { toolName: 'bash' })
  const prompts = env.tg.callsOf('sendMessage').filter((call) => /Approval needed/.test(call.params.text))
  assert.match(prompts[0].params.text, /\n@ivan_tg$/)
  assert.match(prompts[1].params.text, /\n@ivan_tg$/)
  const lookups = env.tg.callsOf('getChatMember')
  assert.equal(lookups.length, 1)
  assert.equal(Number(lookups[0].params.user_id), OWNER)
  assert.equal(Number(lookups[0].params.chat_id), CHAT)
  assert.deepEqual(env.store.state('users')[OWNER], { username: 'ivan_tg', name: 'Ivan' })
})

test('a user without a username is mentioned by the name Telegram returns', async (t) => {
  const env = await env0(t)
  env.tg.members.set(OWNER, { first_name: 'Ivan', last_name: 'Petrov' })
  await env.bridge.requestApproval('session-a', { toolName: 'bash' })
  const prompt = env.tg.callsOf('sendMessage').find((call) => /Approval needed/.test(call.params.text))
  assert.match(prompt.params.text, new RegExp(`<a href="tg://user\\?id=${OWNER}">Ivan Petrov</a>$`))
})

test('a failed lookup falls back to "you" and is not retried right away', async (t) => {
  const env = await env0(t)
  env.tg.failNext('getChatMember', { error_code: 400, description: 'Bad Request: user not found' })
  await env.bridge.requestApproval('session-a', { toolName: 'bash' })
  await env.bridge.requestApproval('session-a', { toolName: 'bash' })
  const prompts = env.tg.callsOf('sendMessage').filter((call) => /Approval needed/.test(call.params.text))
  assert.equal(prompts.length, 2)
  for (const prompt of prompts) assert.match(prompt.params.text, />you<\/a>$/)
  assert.equal(env.tg.callsOf('getChatMember').length, 1)
})

test('pressing a button remembers the user too', async (t) => {
  const env = await env0(t)
  const handle = await env.bridge.requestQuestions('session-a', [{ id: 'q', question: 'Go?', options: [{ label: 'Yes' }] }])
  void handle
  const button = env.tg.callsOf('sendMessage').at(-1).params.reply_markup.inline_keyboard[0][0]
  await env.bridge.handleUpdate({ callback_query: { id: 'cb1', data: button.callback_data, from: { id: OWNER, is_bot: false, first_name: 'Ivan', username: 'ivan_btn' }, message: { message_id: 1, chat: { id: CHAT } } } })
  await settle(env, 'session-a')
  assert.equal(env.store.state('users')[OWNER].username, 'ivan_btn')
})

test('mentions can be turned off', async (t) => {
  const env = await env0(t, { settings: { mentionUser: false } })
  await env.bridge.handleUpdate(topicMessage(300, 'go', { from }))
  await env.bridge.requestQuestions('session-a', [{ id: 'q', question: 'Continue?', options: [{ label: 'Yes' }] }])
  env.bridge.onTurnStarted('session-a')
  env.bridge.onTurnEnded('session-a', { reason: 'completed' })
  await settle(env, 'session-a')
  for (const call of env.tg.callsOf('sendMessage')) assert.doesNotMatch(call.params.text, /@owner_tg|tg:\/\/user/)
})

test('the first question of a batch mentions the requester', async (t) => {
  const env = await env0(t)
  await env.bridge.handleUpdate(topicMessage(300, 'go', { from }))
  await env.bridge.requestQuestions('session-a', [
    { id: 'a', question: 'First?', options: [{ label: 'Yes' }] },
    { id: 'b', question: 'Second?', options: [{ label: 'No' }] },
  ])
  const texts = env.tg.callsOf('sendMessage').map((call) => call.params.text)
  assert.match(texts.find((text) => /First\?/.test(text)), /@owner_tg$/)
  assert.doesNotMatch(texts.find((text) => /Second\?/.test(text)), /@owner_tg/)
})

test('questions answered in DSH show the chosen answers in Telegram', async (t) => {
  const env = await env0(t)
  const handle = await env.bridge.requestQuestions('session-a', [
    { id: 'db', question: 'Which database?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] },
    { id: 'name', question: 'Project name?', options: [{ label: 'demo' }] },
  ])
  handle.answered([{ id: 'db', selected: ['SQLite'] }, { id: 'name', selected: [], custom: 'acme' }], 'Answered in DSH')
  assert.equal(await handle.answer, undefined)
  await settle(env, 'session-a')
  const edits = env.tg.callsOf('editMessageText').map((call) => call.params.text)
  assert.ok(edits.some((text) => /Which database\?[\s\S]*<b>Answer:<\/b> SQLite\n<i>Answered in DSH<\/i>$/.test(text)), edits.join('\n---\n'))
  assert.ok(edits.some((text) => /Project name\?[\s\S]*<b>Answer:<\/b> “acme”/.test(text)))
})

const png = (name) => Object.assign(new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }), { name })

test('pictures of a DSH message follow its text: one as a photo, several as an album', async (t) => {
  const reads = []
  const host = fakeHost({
    async readImage(id, ref) {
      reads.push([id, ref.attachmentId])
      return png(`${ref.attachmentId}.${ref.mediaType === 'image/gif' ? 'gif' : 'png'}`)
    },
  })
  const env = await env0(t, { host })
  env.bridge.onUserMessage('session-a', { text: 'look', source: { kind: 'user' }, images: [{ attachmentId: 'one', mediaType: 'image/png' }] })
  await settle(env, 'session-a')
  env.bridge.onUserMessage('session-a', {
    text: 'and these',
    source: { kind: 'user' },
    images: [{ attachmentId: 'a', mediaType: 'image/png' }, { attachmentId: 'b', mediaType: 'image/png' }, { attachmentId: 'c', mediaType: 'image/gif' }],
  })
  await settle(env, 'session-a')
  assert.deepEqual(reads.map(([, id]) => id), ['one', 'a', 'b', 'c'])
  const methods = env.tg.calls.filter((call) => /^send(Message|Photo|MediaGroup|Document)$/.test(call.method)).map((call) => call.method)
  assert.deepEqual(methods, ['sendMessage', 'sendPhoto', 'sendMessage', 'sendMediaGroup', 'sendDocument'])
  assert.match(env.tg.callsOf('sendMessage')[1].params.text, /You \(DSH\)<\/b> 🖼×3/)
  const album = env.tg.callsOf('sendMediaGroup')[0].params
  assert.deepEqual(JSON.parse(album.media), [{ type: 'photo', media: 'attach://photo0' }, { type: 'photo', media: 'attach://photo1' }])
  assert.equal(album.photo0.name, 'a.png')
  assert.equal(Number(album.message_thread_id), 300)
})

test('a refused album is sent picture by picture', async (t) => {
  const env = await env0(t, { host: fakeHost({ readImage: async (_id, ref) => png(`${ref.attachmentId}.png`) }) })
  env.tg.failNext('sendMediaGroup', { error_code: 400, description: 'Bad Request: PHOTO_INVALID_DIMENSIONS' })
  env.bridge.onUserMessage('session-a', { text: 'x', source: { kind: 'user' }, images: [{ attachmentId: 'a' }, { attachmentId: 'b' }] })
  await settle(env, 'session-a')
  assert.equal(env.tg.callsOf('sendPhoto').length, 2)
})

test('wireEvents passes image attachment refs of a DSH message to the bridge', async () => {
  const { wireEvents } = await import('../lib/host.js')
  const { fakeCtx, fakeSession } = await import('./harness.mjs')
  const seen = []
  const ctx = fakeCtx({ sessions: { get: () => undefined } })
  wireEvents(ctx, () => ({ onUserMessage: (id, message) => seen.push([id, message]) }))
  const ref = { attachmentId: 'sha256:abc', mediaType: 'image/png', bytes: 4, width: 1, height: 1 }
  ctx.emit('session/event', fakeSession('session-a'), { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }, { type: 'image', attachment: ref }] } })
  assert.deepEqual(seen[0][1].images, [ref])
  assert.equal(seen[0][1].text, 'hi')
})

test('host.readImage reads the attachment store and names the file by its type', async () => {
  const dsh = createFakeDsh()
  const asked = []
  dsh.services.attachments = {
    readImage: async (ref) => {
      asked.push(ref.attachmentId)
      return { ref, data: new Uint8Array([1, 2, 3]) }
    },
  }
  const host = createHost(dsh.ctx, () => ({}))
  const file = await host.readImage('session-a', { attachmentId: 'sha256:abc', mediaType: 'image/jpeg', name: 'shot.jpeg' })
  assert.equal(file.name, 'shot.jpg')
  assert.equal(file.type, 'image/jpeg')
  assert.equal(file.size, 3)
  assert.deepEqual(asked, ['sha256:abc'])
  const unnamed = await host.readImage('session-a', { attachmentId: 'x', mediaType: 'image/png' })
  assert.equal(unnamed.name, 'image.png')
  delete dsh.services.attachments
  await assert.rejects(host.readImage('session-a', { attachmentId: 'x' }), /not available/)
})
