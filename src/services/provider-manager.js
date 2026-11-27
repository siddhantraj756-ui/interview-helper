const { performance } = require('perf_hooks');
const { OpenAIProvider, classifyError, friendlyError, DEFAULT_MODEL } = require('./openai.provider');

function usableKey(value) {
  const key = typeof value === 'string' ? value.trim() : '';
  return key && !['your_gemini_api_key_here', 'your_openai_api_key_here', 'your-api-key-here'].includes(key) ? key : '';
}

class ProviderManager {
  constructor({ geminiService, credentialStore, openaiProvider = new OpenAIProvider(), getCandidateContext = () => ({}) } = {}) {
    this.gemini = geminiService;
    this.credentials = credentialStore;
    this.openai = openaiProvider;
    this.getCandidateContext = getCandidateContext;
    this.geminiQueue = Promise.resolve();
  }

  getStatus() {
    const paid = !!(usableKey(this.credentials?.get('geminiPaid')) || usableKey(process.env.GEMINI_PAID_API_KEY) || usableKey(process.env.GEMINI_API_KEY));
    const openai = !!(usableKey(this.credentials?.get('openai')) || usableKey(process.env.OPENAI_API_KEY));
    const free = !!(usableKey(this.credentials?.get('geminiFree')) || usableKey(process.env.GEMINI_FREE_API_KEY));
    return { configured: { openai, geminiPaid: paid, geminiFree: free }, preferredProvider: openai ? 'OpenAI' : paid ? 'Gemini (paid)' : free ? 'Gemini (free)' : 'Not configured', model: this.openai.model || DEFAULT_MODEL };
  }

  async testOpenAI() {
    return this.openai.testConnection(usableKey(this.credentials?.get('openai')) || usableKey(process.env.OPENAI_API_KEY));
  }

  async testGemini(tier = 'paid') {
    const key = this._geminiKey(tier);
    if (!key) return { success: false, error: `Gemini ${tier} API key is not configured.` };
    return this._geminiWithKey(key, () => this.gemini.testConnection());
  }

  _geminiKey(tier) {
    if (tier === 'paid') return usableKey(this.credentials?.get('geminiPaid')) || usableKey(process.env.GEMINI_PAID_API_KEY) || usableKey(process.env.GEMINI_API_KEY);
    return usableKey(this.credentials?.get('geminiFree')) || usableKey(process.env.GEMINI_FREE_API_KEY);
  }

  _buildTextRequest(text, activeSkill, sessionHistory, programmingLanguage) {
    const request = this.gemini.buildGeminiRequest(text, activeSkill, sessionHistory, programmingLanguage);
    const prompt = request.systemInstruction?.parts?.map(part => part.text || '').join('\n') || '';
    const turns = (request.contents || []).slice(0, -1).map(item => ({
      role: item.role,
      content: (item.parts || []).map(part => part.text || '').join('\n')
    }));
    const last = turns[turns.length - 1];
    if (last?.role === 'user' && last.content.trim() === String(text || '').trim()) turns.pop();
    return { prompt, history: turns };
  }

  async _geminiWithKey(key, action) {
    const run = this.geminiQueue.then(async () => {
      const originalKey = process.env.GEMINI_API_KEY;
      const originalClient = this.gemini.client;
      const originalModel = this.gemini.model;
      const originalInitialized = this.gemini.isInitialized;
      try {
        process.env.GEMINI_API_KEY = key;
        this.gemini.initializeClient();
        return await action();
      } finally {
        if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
        else process.env.GEMINI_API_KEY = originalKey;
        this.gemini.client = originalClient;
        this.gemini.model = originalModel;
        this.gemini.isInitialized = originalInitialized;
      }
    });
    this.geminiQueue = run.catch(() => {});
    return run;
  }

  async _attempt(request, { activeSkill, programmingLanguage, onDelta, onFirstToken, onRequestStart, apiKey, provider, operation }) {
    if (provider === 'OpenAI') {
      onRequestStart?.(provider);
      return this.openai.generate({ ...request, apiKey, onDelta, onFirstToken });
    }
    return this._geminiWithKey(apiKey, async () => {
      onRequestStart?.(provider);
      const result = await operation(onDelta);
      return { ...result, metadata: { ...result.metadata, provider, model: this.gemini.model } };
    });
  }

  async _run(textRequest, options) {
    const providers = [];
    const openaiKey = usableKey(this.credentials?.get('openai')) || usableKey(process.env.OPENAI_API_KEY);
    const paidKey = this._geminiKey('paid');
    const freeKey = this._geminiKey('free');
    if (openaiKey) providers.push({ name: 'OpenAI', apiKey: openaiKey });
    if (paidKey) providers.push({ name: 'Gemini (paid)', apiKey: paidKey });
    if (freeKey && freeKey !== paidKey) providers.push({ name: 'Gemini (free)', apiKey: freeKey });
    if (!providers.length) throw new Error('No LLM provider is configured. Add an OpenAI or Gemini API key in Settings.');

    const startedAt = performance.now();
    const attempts = [];
    let firstTokenTimeMs = null;
    let lastError;
    for (let i = 0; i < providers.length; i++) {
      const provider = providers[i];
      let emitted = false;
      const markFirstToken = () => {
        if (firstTokenTimeMs !== null) return;
        firstTokenTimeMs = performance.now() - startedAt;
        options.onFirstToken?.(provider.name);
      };
      const onProviderDelta = delta => {
        emitted = true;
        markFirstToken();
        options.onDelta?.(delta);
      };
      try {
        const attemptOptions = {
          ...options,
          provider: provider.name,
          apiKey: provider.apiKey,
          onDelta: onProviderDelta,
          onRequestStart: () => options.onRequestStart?.(provider.name),
          onFirstToken: markFirstToken,
          operation: options.geminiOperation
        };
        let result;
        try {
          result = await this._attempt(textRequest, attemptOptions);
        } catch (error) {
          const type = classifyError(error);
          const retryAfterMs = Number(error.retryAfter) * 1000;
          const retryableStatus = provider.name === 'OpenAI'
            && !emitted
            && [429, 503].includes(error.status)
            && ['RATE_LIMIT_ERROR', 'TEMPORARY_ERROR'].includes(type)
            && (!Number.isFinite(retryAfterMs) || retryAfterMs <= 2000);
          if (!retryableStatus) throw error;
          await new Promise(resolve => setTimeout(resolve, Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : 250));
          result = await this._attempt(textRequest, attemptOptions);
        }
        return {
          ...result,
          metadata: {
            ...result.metadata,
            provider: provider.name,
            model: result.metadata?.model || (provider.name === 'OpenAI' ? this.openai.model : this.gemini.model),
            timeToFirstTokenMs: firstTokenTimeMs,
            processingTime: performance.now() - startedAt,
            usedFallback: i > 0,
            fallbackProviders: attempts,
            requestId: options.requestId
          }
        };
      } catch (error) {
        lastError = error;
        const type = classifyError(error);
        attempts.push({ provider: provider.name, errorType: type });
        const canFallback = i < providers.length - 1 && ['TEMPORARY_ERROR', 'RATE_LIMIT_ERROR', 'QUOTA_ERROR'].includes(type);
        if (!canFallback || (type === 'TEMPORARY_ERROR' && emitted && error.status == null)) {
          const message = friendlyError(error);
          throw Object.assign(new Error(message), { provider: provider.name, errorType: type, cause: error });
        }
        if (emitted) options.onReset?.();
      }
    }
    throw lastError || new Error('All configured LLM providers failed.');
  }

  async processTextWithSkillStream(text, activeSkill, sessionHistory = [], programmingLanguage = null, onDelta = null, timing = {}) {
    const request = this._buildTextRequest(text, activeSkill, sessionHistory, programmingLanguage);
    const context = this.getCandidateContext();
    const prompt = `${request.prompt}\n\n${require('./prompt-builder').buildInterviewInstructions(context)}`;
    return this._run({ ...request, prompt, text }, {
      requestId: timing.requestId,
      activeSkill,
      programmingLanguage,
      onDelta,
      onRequestStart: timing.onRequestStart,
      onFirstToken: timing.onFirstToken,
      onFirstToken: timing.onFirstToken,
      onReset: timing.onReset,
      geminiOperation: onProviderDelta => this.gemini.processTextWithSkillStream(text, activeSkill, sessionHistory, programmingLanguage, onProviderDelta, prompt)
    });
  }

  async processImageWithSkillStream(imageBuffer, mimeType, activeSkill, sessionHistory = [], programmingLanguage = null, onDelta = null, timing = {}) {
    const context = this.getCandidateContext();
    const skillPrompt = require('../../prompt-loader').promptLoader.getSkillPrompt(activeSkill, programmingLanguage) || '';
    const instructions = `${skillPrompt}\n\n${require('./prompt-builder').buildInterviewInstructions(context)}`;
    const dataUrl = `data:${mimeType || 'image/png'};base64,${Buffer.from(imageBuffer).toString('base64')}`;
    const history = (sessionHistory || []).filter(turn => turn?.content).map(turn => ({ role: turn.role, content: turn.content }));
    const text = 'Analyze the interview question or technical content in the attached image. Answer directly and accurately.';
    const input = history.map(turn => ({ role: turn.role === 'model' ? 'assistant' : 'user', content: turn.content }));
    input.push({ role: 'user', content: [{ type: 'input_text', text }, { type: 'input_image', image_url: dataUrl }] });
    const request = { instructions, input, text };
    return this._run(request, {
      activeSkill,
      programmingLanguage,
      onDelta,
      onFirstToken: timing.onFirstToken,
      onReset: timing.onReset,
      geminiOperation: onProviderDelta => this.gemini.processImageWithSkillStream(imageBuffer, mimeType, activeSkill, sessionHistory, programmingLanguage, onProviderDelta)
    });
  }
}

module.exports = ProviderManager;
