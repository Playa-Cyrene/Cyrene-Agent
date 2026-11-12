// Deliberately network-free test peer. Never included in the module or desktop entry.
const capabilities = { messages: { text: true, image: false, audio: false, file: false, video: false, markdown: false, card: false, sticker: false, reply: true, mention: true, maxTextLength: 32768, maxFileBytes: 0 }, backend: { napcatStream: false } };
let config;
process.on('message', (request) => {
  const identity = { apiVersion: request.apiVersion, instanceId: request.instanceId, runtimeEpoch: request.runtimeEpoch };
  const respond = (payload) => process.send({ ...identity, kind: 'response', responseTo: request.requestId, ok: true, payload });
  switch (request.method) {
    case 'hello': respond({ moduleId: 'qfca', moduleVersion: '0.1.0-fake', apiSupport: { major: 1, minMinor: 0, maxMinor: 0 } }); break;
    case 'initialize': config = request.payload.config; respond({ capabilities }); break;
    case 'start':
      respond({ phase: 'running', selfId: config.expectedSelfId, connectionEpoch: 1 });
      setImmediate(() => process.send({ ...identity, kind: 'event', event: 'inbound', payload: {
        eventId: 'fake-event', backendMessageId: '100', selfId: config.expectedSelfId, connectionEpoch: 1, configRevision: config.configRevision,
        conversation: { type: 'private', peerId: '30000' }, senderId: '30000', timestampMs: 1700000000000, text: 'fake child input',
      } }));
      break;
    case 'send':
      if (request.payload.parts[0]?.text === 'crash') { process.exit(9); break; }
      if (request.payload.parts[0]?.text === 'hang') break;
      respond({ operationId: request.payload.operationId, outcome: 'sent', parts: request.payload.parts.map((_, partIndex) => ({ partIndex, outcome: 'sent', messageId: '101' })) }); break;
    default: respond({});
  }
});
process.on('disconnect', () => process.exit(0));
if (process.env.QQ_TEST_IGNORE_TERM === '1') process.on('SIGTERM', () => {});
