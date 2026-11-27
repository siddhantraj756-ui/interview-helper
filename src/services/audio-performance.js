const { performance } = require('perf_hooks');

const STATES = Object.freeze([
  'idle',
  'listening',
  'transcribing',
  'submitting_to_llm',
  'receiving_response',
  'completed',
  'error'
]);

const ALLOWED_TRANSITIONS = {
  idle: new Set(['listening', 'transcribing', 'submitting_to_llm', 'error']),
  listening: new Set(['transcribing', 'submitting_to_llm', 'completed', 'error', 'idle']),
  transcribing: new Set(['submitting_to_llm', 'completed', 'error', 'idle']),
  submitting_to_llm: new Set(['receiving_response', 'completed', 'error']),
  receiving_response: new Set(['completed', 'error']),
  completed: new Set(['idle', 'listening']),
  error: new Set(['idle', 'listening', 'transcribing', 'submitting_to_llm'])
};

const STAGE_TIMES = {
  mic_button_clicked: 'micClickedAt',
  audio_capture_initialized: 'captureInitializedAt',
  mic_button_clicked_to_submit: 'stopClickedAt',
  audio_capture_stopped: 'captureStoppedAt',
  transcription_started: 'transcriptionStartedAt',
  final_transcription_completed: 'transcriptionCompletedAt',
  llm_request_submitted: 'llmSubmittedAt',
  llm_first_token_received: 'firstTokenAt',
  llm_response_completed: 'llmCompletedAt',
  first_response_rendered: 'firstRenderedAt'
};

function nonNegativeDuration(end, start) {
  return Number.isFinite(end) && Number.isFinite(start) ? Math.max(0, end - start) : null;
}

function safeErrorDetails(error) {
  if (!error) return undefined;
  const rawMessage = String(error.message || error);
  const message = rawMessage
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|AIza[\w-]{20,})\b/g, '[redacted]')
    .slice(0, 300);
  return {
    name: String(error.name || 'Error').slice(0, 80),
    code: error.code == null ? undefined : String(error.code).slice(0, 80),
    message
  };
}

class AudioPerformanceTracker {
  constructor({
    logger = null,
    deploymentMode = 'local',
    now = () => performance.now(),
    wallClock = () => new Date().toISOString(),
    onStateChange = null,
    maxRequests = 500
  } = {}) {
    this.logger = logger;
    this.deploymentMode = deploymentMode === 'hosted' ? 'hosted' : 'local';
    this.now = now;
    this.wallClock = wallClock;
    this.onStateChange = onStateChange;
    this.maxRequests = maxRequests;
    this.requests = new Map();
    this.submitted = new Set();
  }

  begin(requestId, { speechProvider = 'unknown', llmProvider = 'unknown', captureSessionId = null } = {}) {
    if (!requestId || this.requests.has(requestId)) return false;
    this.requests.set(requestId, {
      requestId,
      state: 'idle',
      speechProvider,
      llmProvider,
      captureSessionId,
      times: {},
      transcriptCount: 0,
      partialSequence: 0
    });
    this._prune();
    return true;
  }

  ensure(requestId, metadata = {}) {
    if (!this.requests.has(requestId)) this.begin(requestId, metadata);
    return this.requests.get(requestId) || null;
  }

  claimSubmission(requestId) {
    if (!requestId || this.submitted.has(requestId)) return false;
    this.submitted.add(requestId);
    this._pruneSubmitted();
    return true;
  }

  transition(requestId, nextState, metadata = {}) {
    const request = this.ensure(requestId, metadata);
    if (!request || !STATES.includes(nextState)) return false;
    const previousState = request.state;
    if (previousState === nextState) return true;
    if (!ALLOWED_TRANSITIONS[previousState]?.has(nextState)) {
      this.record(requestId, 'invalid_state_transition', {
        fromState: previousState,
        requestedState: nextState
      });
      return false;
    }
    request.state = nextState;
    this.record(requestId, 'workflow_state_changed', {
      fromState: previousState,
      state: nextState
    });
    if (this.onStateChange) {
      try {
        this.onStateChange({ requestId, previousState, state: nextState });
      } catch (_) {
        // Observability must not interrupt the audio or response path.
      }
    }
    return true;
  }

  recordStage(requestId, stage, details = {}) {
    const request = this.ensure(requestId, details);
    if (!request) return null;
    const monotonicMs = Number.isFinite(details.monotonicMs) ? details.monotonicMs : this.now();
    const timeKey = STAGE_TIMES[stage];
    if (timeKey && (request.times[timeKey] === undefined || stage === 'final_transcription_completed')) {
      request.times[timeKey] = monotonicMs;
    }
    if (stage === 'final_transcription_fragment_received') request.transcriptCount++;
    if (stage === 'partial_transcription_received') request.partialSequence++;

    const metrics = this.metrics(requestId);
    let durationMs = Number.isFinite(details.durationMs) ? details.durationMs : null;
    if (stage === 'audio_capture_initialized') durationMs = metrics.audioInitializationLatencyMs;
    if (stage === 'audio_capture_stopped') durationMs = metrics.audioCaptureStopLatencyMs;
    if (stage === 'final_transcription_completed') durationMs = metrics.totalTranscriptionDurationMs;
    if (stage === 'llm_first_token_received') durationMs = metrics.llmFirstTokenLatencyMs;
    if (stage === 'llm_response_completed') durationMs = metrics.llmGenerationDurationMs;
    if (stage === 'first_response_rendered') durationMs = metrics.stopToFirstVisibleAnswerMs;

    this.record(requestId, stage, {
      ...details,
      durationMs,
      monotonicMs,
      ...metrics
    });
    return metrics;
  }

  record(requestId, stage, details = {}) {
    const request = this.ensure(requestId, details);
    if (!request) return null;
    if (details.speechProvider) request.speechProvider = details.speechProvider;
    if (details.llmProvider) request.llmProvider = details.llmProvider;
    const event = {
      requestId,
      timestamp: this.wallClock(),
      monotonicMs: Number.isFinite(details.monotonicMs) ? details.monotonicMs : this.now(),
      deploymentMode: this.deploymentMode,
      speechProvider: request.speechProvider,
      llmProvider: request.llmProvider,
      stage,
      ...(request.captureSessionId ? { captureSessionId: request.captureSessionId } : {}),
      ...(request.state ? { state: request.state } : {}),
      ...(Number.isFinite(details.durationMs) ? { durationMs: Math.max(0, details.durationMs) } : {}),
      ...(Number.isFinite(details.audioInitializationLatencyMs) ? { audioInitializationLatencyMs: details.audioInitializationLatencyMs } : {}),
      ...(Number.isFinite(details.audioCaptureStopLatencyMs) ? { audioCaptureStopLatencyMs: details.audioCaptureStopLatencyMs } : {}),
      ...(Number.isFinite(details.postStopTranscriptionLatencyMs) ? { postStopTranscriptionLatencyMs: details.postStopTranscriptionLatencyMs } : {}),
      ...(Number.isFinite(details.totalTranscriptionDurationMs) ? { totalTranscriptionDurationMs: details.totalTranscriptionDurationMs } : {}),
      ...(Number.isFinite(details.llmFirstTokenLatencyMs) ? { llmFirstTokenLatencyMs: details.llmFirstTokenLatencyMs } : {}),
      ...(Number.isFinite(details.llmGenerationDurationMs) ? { llmGenerationDurationMs: details.llmGenerationDurationMs } : {}),
      ...(Number.isFinite(details.stopToFirstVisibleAnswerMs) ? { stopToFirstVisibleAnswerMs: details.stopToFirstVisibleAnswerMs } : {}),
      ...(Number.isFinite(details.stopToCompleteAnswerMs) ? { stopToCompleteAnswerMs: details.stopToCompleteAnswerMs } : {}),
      ...(Number.isFinite(details.transcriptCount) ? { transcriptCount: details.transcriptCount } : {}),
      ...(Number.isFinite(details.partialSequence) ? { partialSequence: details.partialSequence } : {}),
      ...(details.provider ? { provider: details.provider } : {}),
      ...(details.fromState ? { fromState: details.fromState } : {}),
      ...(details.requestedState ? { requestedState: details.requestedState } : {}),
      ...(details.error ? { error: safeErrorDetails(details.error) } : {}),
      ...(details.errorName ? { errorName: String(details.errorName).slice(0, 80) } : {}),
      ...(details.errorCode ? { errorCode: String(details.errorCode).slice(0, 80) } : {}),
      ...(Number.isFinite(details.textLength) ? { textLength: details.textLength } : {})
    };
    if (this.logger?.info) this.logger.info('Audio performance event', event);
    return event;
  }

  metrics(requestId) {
    const times = this.requests.get(requestId)?.times || {};
    return {
      audioInitializationLatencyMs: nonNegativeDuration(times.captureInitializedAt, times.micClickedAt),
      audioCaptureStopLatencyMs: nonNegativeDuration(times.captureStoppedAt, times.stopClickedAt),
      postStopTranscriptionLatencyMs: nonNegativeDuration(times.transcriptionCompletedAt, times.stopClickedAt),
      totalTranscriptionDurationMs: nonNegativeDuration(times.transcriptionCompletedAt, times.transcriptionStartedAt),
      llmFirstTokenLatencyMs: nonNegativeDuration(times.firstTokenAt, times.llmSubmittedAt),
      llmGenerationDurationMs: nonNegativeDuration(times.llmCompletedAt, times.firstTokenAt),
      stopToFirstVisibleAnswerMs: nonNegativeDuration(times.firstRenderedAt, times.stopClickedAt),
      stopToCompleteAnswerMs: nonNegativeDuration(times.llmCompletedAt, times.stopClickedAt)
    };
  }

  getState(requestId) {
    return this.requests.get(requestId)?.state || null;
  }

  _prune() {
    while (this.requests.size > this.maxRequests) {
      const oldest = this.requests.keys().next().value;
      this.requests.delete(oldest);
      this.submitted.delete(oldest);
    }
  }

  _pruneSubmitted() {
    while (this.submitted.size > this.maxRequests) {
      const oldest = this.submitted.values().next().value;
      this.submitted.delete(oldest);
    }
  }
}

module.exports = { AudioPerformanceTracker, STATES, ALLOWED_TRANSITIONS, safeErrorDetails };
