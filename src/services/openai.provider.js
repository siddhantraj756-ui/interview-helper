const DEFAULT_MODEL = 'gpt-6.2-sol';

function makeHttpError(status, body, headers) {
  const error = new Error(body?.error?.message || `OpenAI request failed with HTTP ${status}`);
  error.status = status;
  error.code = body?.error?.code || body?.error?.type;
  error.retryAfter = headers?.get?.('retry-after');
  return error;
}

function normalizeHistory(turns = []) {
  return turns.filter(turn => turn && typeof turn.content === 'string' && turn.content.trim())
    .map(turn => ({ role: turn.role === 'model' || turn.role === 'assistant' ? 'assistant' : 'user', content: turn.content }));
}

class OpenAIProvider {
  constructor({ fetchImpl = global.fetch, model = process.env.OPENAI_MODEL || DEFAULT_MODEL, timeoutMs = 60000 } = {}) {
    this.fetch = fetchImpl;
    this.model = model;
    this.timeoutMs = timeoutMs;
  }

  _requestBody({ instructions, input, stream }) {
    return {
      model: this.model,
      instructions,
      input,
      max_output_tokens: 4096,
      reasoning: { effort: 'low' },
      stream,
      store: false
    };
  }

  _messages(prompt, history, text) {
    const input = normalizeHistory(history);
    input.push({ role: 'user', content: text });
    return { instructions: prompt, input };
  }

  async generate({ apiKey, prompt, history, text, instructions, input, onDelta, onFirstToken }) {
    if (!apiKey) throw Object.assign(new Error('OpenAI API key is not configured.'), { kind: 'configuration' });
    const messages = prompt !== undefined || history !== undefined
      ? this._messages(prompt || '', history, text)
      : { instructions: instructions || '', input: input || [] };
    const startedAt = performance.now();
    let firstTokenMs = null;
    const response = await this.fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(this._requestBody({ ...messages, stream: true })),
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    if (!response.ok) {
      let body = {};
      try { body = await response.json(); } catch (_) { /* Ignore non-JSON provider errors. */ }
      throw makeHttpError(response.status, body, response.headers);
    }

    let answer = '';
    let buffer = '';
    let usage = null;
    const consumeEvent = eventText => {
      const data = eventText.split(/\r?\n/).filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trim()).join('\n');
      if (!data || data === '[DONE]') return;
      let event;
      try { event = JSON.parse(data); } catch (_) { return; }
      if (event.type === 'error' || event.type === 'response.failed') {
        throw Object.assign(new Error(event.message || event.response?.error?.message || 'OpenAI response failed.'), {
          status: event.status || event.response?.status,
          code: event.code || event.response?.error?.code
        });
      }
      if (event.type === 'response.completed' && event.response?.usage) usage = event.response.usage;
      if (event.type === 'response.output_text.delta' && event.delta) {
        if (firstTokenMs === null) {
          firstTokenMs = performance.now() - startedAt;
          onFirstToken?.(firstTokenMs);
        }
        answer += event.delta;
        onDelta?.(event.delta);
      }
    };
    for await (const chunk of response.body) {
      buffer += Buffer.from(chunk).toString('utf8');
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(buffer)) !== null) {
        consumeEvent(buffer.slice(0, boundary.index));
        buffer = buffer.slice(boundary.index + boundary[0].length);
      }
    }
    if (buffer.trim()) consumeEvent(buffer);
    if (!answer.trim()) throw new Error('OpenAI returned an empty response.');
    return {
      response: answer.trim(),
      metadata: { provider: 'OpenAI', model: this.model, streamed: true, timeToFirstTokenMs: firstTokenMs, usage }
    };
  }

  async testConnection(apiKey) {
    if (!apiKey) return { success: false, error: 'OpenAI API key is not configured.' };
    try {
      const response = await this.fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, input: 'Reply with OK.', max_output_tokens: 8, store: false }),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
      if (!response.ok) {
        let body = {};
        try { body = await response.json(); } catch (_) { /* Ignore non-JSON errors. */ }
        const error = makeHttpError(response.status, body, response.headers);
        return { success: false, error: friendlyError(error), errorType: classifyError(error) };
      }
      return { success: true, provider: 'OpenAI', model: this.model };
    } catch (error) {
      return { success: false, error: friendlyError(error), errorType: classifyError(error) };
    }
  }
}

function classifyError(error) {
  const message = String(error?.message || '').toLowerCase();
  const geminiType = error?.errorAnalysis?.type;
  if (geminiType) {
    if (geminiType === 'AUTH_ERROR') return 'AUTH_ERROR';
    if (geminiType === 'RATE_LIMIT_ERROR') return /quota|billing/.test(message) ? 'QUOTA_ERROR' : 'RATE_LIMIT_ERROR';
    if (geminiType === 'NETWORK_ERROR' || geminiType === 'TIMEOUT_ERROR' || geminiType === 'SERVICE_ERROR') return 'TEMPORARY_ERROR';
    return 'CONFIGURATION_ERROR';
  }
  if ([401, 403].includes(error?.status)) return 'AUTH_ERROR';
  if (/http 401|http 403|invalid api key|unauthorized|permission denied/.test(message)) return 'AUTH_ERROR';
  if (/quota|billing|usage.?limit/.test(`${error?.code || ''} ${message}`)) return 'QUOTA_ERROR';
  if (error?.status === 429 && /quota|billing|usage limit/.test(`${error.code || ''} ${message}`)) return 'QUOTA_ERROR';
  if (error?.status === 429) return 'RATE_LIMIT_ERROR';
  if (error?.status >= 500 || error?.name === 'TimeoutError' || error?.name === 'AbortError' || !error?.status) return 'TEMPORARY_ERROR';
  return 'CONFIGURATION_ERROR';
}

function friendlyError(error) {
  const type = classifyError(error);
  if (type === 'AUTH_ERROR') return 'OpenAI rejected the API key. Check the key and project access in Settings.';
  if (type === 'QUOTA_ERROR') return 'OpenAI usage or billing limit was reached.';
  if (type === 'RATE_LIMIT_ERROR') return 'OpenAI is rate limiting requests. Please wait before trying again.';
  if (type === 'TEMPORARY_ERROR') return 'OpenAI is temporarily unavailable or the request timed out.';
  return 'OpenAI request could not be completed. Check the model and API settings.';
}

module.exports = { OpenAIProvider, classifyError, friendlyError, DEFAULT_MODEL };
