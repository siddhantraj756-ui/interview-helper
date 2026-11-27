const test = require('node:test');
const assert = require('node:assert/strict');
const { AudioPerformanceTracker } = require('../src/services/audio-performance');
const ProviderManager = require('../src/services/provider-manager');

function createTracker({ deploymentMode = 'local' } = {}) {
  let now = 100;
  const events = [];
  const states = [];
  const tracker = new AudioPerformanceTracker({
    logger: { info: (_message, event) => events.push(event) },
    deploymentMode,
    now: () => now,
    wallClock: () => '2026-11-27T00:00:00.000Z',
    onStateChange: event => states.push(event)
  });
  return { tracker, events, states, advance: milliseconds => { now += milliseconds; } };
}

test('request ID, deployment mode, and providers propagate into each performance event', () => {
  const { tracker, events, advance } = createTracker({ deploymentMode: 'hosted' });
  const requestId = 'test-request-0001';
  tracker.begin(requestId, { speechProvider: 'whisper', llmProvider: 'OpenAI' });
  tracker.recordStage(requestId, 'mic_button_clicked');
  advance(30);
  tracker.recordStage(requestId, 'audio_capture_initialized');

  assert.equal(events.length, 2);
  for (const event of events) {
    assert.equal(event.requestId, requestId);
    assert.equal(event.deploymentMode, 'hosted');
    assert.equal(event.speechProvider, 'whisper');
    assert.equal(event.llmProvider, 'OpenAI');
    assert.ok(event.timestamp);
    assert.ok(Number.isFinite(event.monotonicMs));
  }
  assert.equal(events[1].audioInitializationLatencyMs, 30);
  assert.equal(events[1].durationMs, 30);
});

test('calculates monotonic stage and end-to-end latency values', () => {
  const { tracker, advance } = createTracker();
  const requestId = 'test-request-0002';
  tracker.begin(requestId, { speechProvider: 'whisper', llmProvider: 'OpenAI' });
  tracker.recordStage(requestId, 'mic_button_clicked'); // 100
  advance(20);
  tracker.recordStage(requestId, 'audio_capture_initialized'); // 120
  tracker.transition(requestId, 'listening');
  advance(100);
  tracker.recordStage(requestId, 'mic_button_clicked_to_submit'); // 220
  tracker.transition(requestId, 'transcribing');
  advance(5);
  tracker.recordStage(requestId, 'audio_capture_stopped'); // 225
  advance(10);
  tracker.recordStage(requestId, 'transcription_started'); // 235
  advance(40);
  tracker.recordStage(requestId, 'final_transcription_completed'); // 275
  tracker.transition(requestId, 'submitting_to_llm');
  advance(30);
  tracker.recordStage(requestId, 'llm_request_submitted'); // 305
  advance(70);
  tracker.recordStage(requestId, 'llm_first_token_received'); // 375
  tracker.transition(requestId, 'receiving_response');
  advance(120);
  tracker.recordStage(requestId, 'llm_response_completed'); // 495
  tracker.transition(requestId, 'completed');
  advance(8);
  tracker.recordStage(requestId, 'first_response_rendered'); // 503

  assert.deepEqual(tracker.metrics(requestId), {
    audioInitializationLatencyMs: 20,
    audioCaptureStopLatencyMs: 5,
    postStopTranscriptionLatencyMs: 55,
    totalTranscriptionDurationMs: 40,
    llmFirstTokenLatencyMs: 70,
    llmGenerationDurationMs: 120,
    stopToFirstVisibleAnswerMs: 283,
    stopToCompleteAnswerMs: 275
  });
});

test('enforces workflow state transitions and permits recovery after an error', () => {
  const { tracker, states, events } = createTracker();
  const requestId = 'test-request-0003';
  tracker.begin(requestId);
  assert.equal(tracker.transition(requestId, 'listening'), true);
  assert.equal(tracker.transition(requestId, 'transcribing'), true);
  assert.equal(tracker.transition(requestId, 'receiving_response'), false);
  assert.equal(tracker.getState(requestId), 'transcribing');
  assert.equal(tracker.transition(requestId, 'error'), true);
  assert.equal(tracker.transition(requestId, 'listening'), true);
  assert.equal(states.at(-1).state, 'listening');
  assert.ok(events.some(event => event.stage === 'invalid_state_transition'));
});

test('allows one LLM submission per request ID and supports a new retry ID', () => {
  const { tracker, events } = createTracker();
  assert.equal(tracker.claimSubmission('test-request-0004'), true);
  assert.equal(tracker.claimSubmission('test-request-0004'), false);
  assert.equal(tracker.claimSubmission('test-request-0005'), true);
  tracker.record('test-request-0004', 'duplicate_llm_submission_ignored');
  assert.ok(events.some(event => event.requestId === 'test-request-0004'
    && event.stage === 'duplicate_llm_submission_ignored'));
});

test('provider manager carries the request ID through streamed provider events and result metadata', async () => {
  const requestEvents = [];
  const chunks = [];
  const manager = new ProviderManager({
    geminiService: {
      model: 'gemini-test',
      buildGeminiRequest: () => ({
        systemInstruction: { parts: [{ text: 'Skill instructions' }] },
        contents: [{ role: 'user', parts: [{ text: 'Question?' }] }]
      })
    },
    credentialStore: { get: name => name === 'openai' ? 'test-key' : null },
    openaiProvider: {
      model: 'openai-test',
      generate: async ({ onFirstToken, onDelta }) => {
        onFirstToken();
        onDelta('Answer');
        return { response: 'Answer', metadata: { processingTime: 12, streamed: true } };
      }
    },
    getCandidateContext: () => ({})
  });
  const requestId = 'test-request-0006';
  const result = await manager.processTextWithSkillStream(
    'Question?', 'programming', [], null,
    delta => chunks.push(delta),
    {
      requestId,
      onRequestStart: provider => requestEvents.push({ stage: 'submitted', requestId, provider }),
      onFirstToken: provider => requestEvents.push({ stage: 'first_token', requestId, provider })
    }
  );

  assert.equal(result.response, 'Answer');
  assert.equal(result.metadata.requestId, requestId);
  assert.deepEqual(chunks, ['Answer']);
  assert.deepEqual(requestEvents.map(event => event.stage), ['submitted', 'first_token']);
  assert.ok(requestEvents.every(event => event.requestId === requestId));
});

test('performance logs include error details without adding transcript fields', () => {
  const { tracker, events } = createTracker();
  const requestId = 'test-request-0007';
  tracker.begin(requestId);
  tracker.record(requestId, 'speech_error', {
    error: Object.assign(new Error('Whisper failed'), { code: 'E_SPEECH' }),
    transcript: 'private meeting text'
  });
  const event = events[0];
  assert.deepEqual(event.error, { name: 'Error', code: 'E_SPEECH', message: 'Whisper failed' });
  assert.equal(Object.hasOwn(event, 'transcript'), false);
});
