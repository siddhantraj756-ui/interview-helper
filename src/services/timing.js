function sumTranscriptionProcessingMs(segments) {
  const measured = (Array.isArray(segments) ? segments : [])
    .map(segment => segment?.processingTimeMs)
    .filter(value => typeof value === 'number' && Number.isFinite(value) && value >= 0);
  return measured.length ? measured.reduce((total, value) => total + value, 0) : null;
}

module.exports = { sumTranscriptionProcessingMs };
