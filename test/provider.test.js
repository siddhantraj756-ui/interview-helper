const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { OpenAIProvider, classifyError } = require('../src/services/openai.provider');
const ProviderManager = require('../src/services/provider-manager');
const CredentialStore = require('../src/services/credential-store');
const { buildInterviewInstructions } = require('../src/services/prompt-builder');
const { sumTranscriptionProcessingMs } = require('../src/services/timing');

function sseResponse(events) {
  const body = Readable.from(events.map(event => Buffer.from(`data: ${JSON.stringify(event)}\r\n\r\n`)));
  return { ok: true, status: 200, body };
}

test('OpenAI Responses streaming returns text, model, and first-token timing', async () => {
  let request;
  const provider = new OpenAIProvider({
    model: 'test-model',
    fetchImpl: async (_url, options) => {
      request = options;
      return sseResponse([
        { type: 'response.output_text.delta', delta: 'A direct ' },
        { type: 'response.output_text.delta', delta: 'answer.' },
        { type: 'response.completed', response: { usage: { input_tokens: 8, output_tokens: 3 } } }
      ]);
    }
  });
  const chunks = [];
  const result = await provider.generate({ apiKey: 'test-secret', prompt: 'Be concise.', history: [], text: 'Question?', onDelta: value => chunks.push(value) });
  assert.equal(result.response, 'A direct answer.');
  assert.equal(result.metadata.model, 'test-model');
  assert.ok(result.metadata.timeToFirstTokenMs >= 0);
  assert.equal(chunks.join(''), result.response);
  assert.equal(request.headers.Authorization, 'Bearer test-secret');
  assert.equal(JSON.parse(request.body).store, false);
});

test('OpenAI connection test reports authentication and quota errors separately', async () => {
  const unauthorized = new OpenAIProvider({ fetchImpl: async () => ({
    ok: false, status: 401, headers: new Headers(), json: async () => ({ error: { message: 'bad key' } })
  }) });
  const auth = await unauthorized.testConnection('bad');
  assert.equal(auth.errorType, 'AUTH_ERROR');
  assert.match(auth.error, /rejected the API key/i);
  assert.equal(classifyError({ status: 429, code: 'insufficient_quota', message: 'quota exceeded' }), 'QUOTA_ERROR');
  assert.equal(classifyError({ status: 429, code: 'rate_limit_exceeded', message: 'slow down' }), 'RATE_LIMIT_ERROR');
});

test('an explicit OpenAI rate limit gets one bounded retry before success', async () => {
  let count = 0;
  const provider = new OpenAIProvider({ fetchImpl: async () => {
    count++;
    if (count === 1) return {
      ok: false, status: 429, headers: { get: () => '0' },
      json: async () => ({ error: { code: 'rate_limit_exceeded', message: 'Please slow down' } })
    };
    return sseResponse([{ type: 'response.output_text.delta', delta: 'Recovered.' }]);
  } });
  const manager = new ProviderManager({
    geminiService: fakeGemini(async () => ({})),
    credentialStore: mapStore({ openai: 'api-key' }),
    openaiProvider: provider
  });
  const result = await manager.processTextWithSkillStream('Question', 'programming');
  assert.equal(result.response, 'Recovered.');
  assert.equal(count, 2);
  assert.equal(result.metadata.provider, 'OpenAI');
});

test('OpenAI temporary outage falls back to the paid Gemini key and identifies the producer', async () => {
  const gemini = fakeGemini(async (key, _text, _onDelta) => ({
    response: 'Gemini answer', metadata: { processingTime: 14, streamed: true, model: 'gemini-test' }
  }));
  const manager = new ProviderManager({
    geminiService: gemini,
    credentialStore: mapStore({ openai: 'open-key', geminiPaid: 'paid-key' }),
    openaiProvider: { model: 'open-test', generate: async () => { throw Object.assign(new Error('temporarily unavailable'), { status: 503 }); } }
  });
  const result = await manager.processTextWithSkillStream('What is a queue?', 'programming');
  assert.equal(result.response, 'Gemini answer');
  assert.equal(result.metadata.provider, 'Gemini (paid)');
  assert.equal(result.metadata.model, 'gemini-test');
  assert.equal(result.metadata.usedFallback, true);
  assert.equal(gemini.calls.length, 1);
});

test('Gemini quota exhaustion moves to the free key without repeating the paid request', async () => {
  const gemini = fakeGemini(async key => {
    if (key === 'paid-key') throw Object.assign(new Error('Gemini quota exceeded'), { errorAnalysis: { type: 'RATE_LIMIT_ERROR' } });
    return { response: 'Free Gemini answer', metadata: { model: 'gemini-test' } };
  });
  const manager = new ProviderManager({
    geminiService: gemini,
    credentialStore: mapStore({ geminiPaid: 'paid-key', geminiFree: 'free-key' }),
    openaiProvider: { model: 'open-test' }
  });
  const result = await manager.processTextWithSkillStream('Explain indexes.', 'programming');
  assert.equal(result.response, 'Free Gemini answer');
  assert.equal(result.metadata.provider, 'Gemini (free)');
  assert.equal(result.metadata.usedFallback, true);
  assert.deepEqual(gemini.calls, ['paid-key', 'free-key']);
});

test('invalid OpenAI credentials are surfaced as configuration errors without silent fallback', async () => {
  const gemini = fakeGemini(async () => ({ response: 'should not run', metadata: {} }));
  const manager = new ProviderManager({
    geminiService: gemini,
    credentialStore: mapStore({ openai: 'bad-key', geminiPaid: 'paid-key' }),
    openaiProvider: { model: 'open-test', generate: async () => { throw Object.assign(new Error('Unauthorized'), { status: 401 }); } }
  });
  await assert.rejects(manager.processTextWithSkillStream('Question', 'programming'), error => error.errorType === 'AUTH_ERROR');
  assert.deepEqual(gemini.calls, []);
});

test('provider manager reports missing configuration and uses transcription/LLM timers', async () => {
  const emptyManager = new ProviderManager({ geminiService: fakeGemini(async () => ({})), credentialStore: mapStore({}) });
  await assert.rejects(emptyManager.processTextWithSkillStream('Question', 'programming'), /No LLM provider/);

  const openai = { model: 'fast-test', generate: async options => {
    options.onDelta?.('answer');
    return { response: 'answer', metadata: { model: 'fast-test' } };
  } };
  const manager = new ProviderManager({ geminiService: fakeGemini(async () => ({})), credentialStore: mapStore({ openai: 'key' }), openaiProvider: openai });
  const result = await manager.processTextWithSkillStream('Question', 'programming');
  assert.equal(result.metadata.provider, 'OpenAI');
  assert.ok(result.metadata.processingTime >= 0);
  assert.ok(result.metadata.timeToFirstTokenMs >= 0);
});

test('secure credential storage writes encrypted bytes, not plaintext keys', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opencluely-credentials-'));
  try {
    const fakeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: value => Buffer.from(`enc:${value}`),
      decryptString: value => value.toString().slice(4),
      getSelectedStorageBackend: () => 'test-keychain'
    };
    const filePath = path.join(directory, 'credentials.json');
    const store = new CredentialStore({ filePath, storage: fakeStorage });
    store.save({ openai: 'private-api-key' });
    const onDisk = fs.readFileSync(filePath, 'utf8');
    assert.equal(onDisk.includes('private-api-key'), false);
    assert.equal(store.get('openai'), 'private-api-key');
    assert.equal(store.save({ openai: null }).openai, false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('secure credential storage refuses weak Linux backend', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opencluely-credentials-'));
  try {
    const store = new CredentialStore({
      filePath: path.join(directory, 'credentials.json'),
      storage: {
        isEncryptionAvailable: () => true,
        getSelectedStorageBackend: () => 'basic_text',
        encryptString: value => Buffer.from(value),
        decryptString: value => value.toString()
      }
    });
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try { assert.throws(() => store.save({ openai: 'secret' }), /system secret store/i); }
    finally { Object.defineProperty(process, 'platform', { value: originalPlatform }); }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('interview instructions use candidate and role context without inventing facts', () => {
  const prompt = buildInterviewInstructions({ candidateContext: 'Built a Go service.', jobDescription: 'Requires PostgreSQL.' });
  assert.match(prompt, /Built a Go service/);
  assert.match(prompt, /Requires PostgreSQL/);
  assert.match(prompt, /Never claim experiences/);
});

test('skill prompts cover coding, technical, behavioral, and system design answers', () => {
  const dsa = fs.readFileSync(path.join(__dirname, '..', 'prompts', 'dsa.md'), 'utf8');
  const programming = fs.readFileSync(path.join(__dirname, '..', 'prompts', 'programming.md'), 'utf8');
  const interview = fs.readFileSync(path.join(__dirname, '..', 'prompts', 'interview.md'), 'utf8');
  assert.match(dsa, /complexity/i);
  assert.match(programming, /security|scaling/i);
  assert.match(interview, /STAR/);
  assert.match(interview, /without pretending it happened/i);
});

test('transcription timing sums only measured speech-processing segments', () => {
  assert.equal(sumTranscriptionProcessingMs([{ processingTimeMs: 800 }, { processingTimeMs: 1200 }]), 2000);
  assert.equal(sumTranscriptionProcessingMs([{ processingTimeMs: null }, {}]), null);
});

function mapStore(values) {
  return { get: name => values[name] || '' };
}

function fakeGemini(onRequest) {
  const calls = [];
  return {
    calls,
    model: 'gemini-test',
    client: {},
    isInitialized: true,
    buildGeminiRequest: () => ({ systemInstruction: { parts: [{ text: 'technical prompt' }] }, contents: [{ role: 'user', parts: [{ text: 'question' }] }] }),
    initializeClient() { this.model = 'gemini-test'; this.client = {}; this.isInitialized = true; },
    processTextWithSkillStream(text, skill, history, language, onDelta) {
      calls.push(process.env.GEMINI_API_KEY);
      return onRequest(process.env.GEMINI_API_KEY, text, onDelta, skill, history, language);
    }
  };
}



