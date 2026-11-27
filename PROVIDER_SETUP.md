# AI Provider Setup

OpenCluely attempts configured providers in this order:

1. OpenAI
2. Paid Gemini
3. Free Gemini

Add or replace keys from **Settings → AI Providers**. Use the show/hide control only when needed. Use **Test connection** to send a short request; the provider may bill this request. The configured model is editable; the default is `gpt-6.2-sol`.

Gemini API keys do not contain a paid/free tier marker. The paid and free labels in Settings are names for the Gemini projects you choose. Give each field the key for the matching project. For backward compatibility, an existing `GEMINI_API_KEY` is treated as the paid Gemini fallback unless a separate paid key is saved.

New keys saved through the app are encrypted with Electron `safeStorage` and kept in the user's app data. Renderer windows receive only configured/status flags. Existing `.env` keys remain supported; if you keep using an environment key, protect that file with appropriate OS permissions. On Linux, configure a system secret store such as GNOME Keyring or KWallet before saving keys through the app. The app refuses to save if Electron reports the weak `basic_text` backend.

Optional environment variables for deployments are listed in `env.example`:

- `OPENAI_API_KEY` and `OPENAI_MODEL`
- `GEMINI_PAID_API_KEY` and `GEMINI_FREE_API_KEY`
- `CANDIDATE_RESUME` and `JOB_DESCRIPTION`

Provider keys entered in Settings take precedence over the matching environment keys. Do not commit real keys or candidate information to source control. Candidate details and job descriptions are sent to whichever provider answers the request.

Fallback occurs for temporary provider failures, rate limits, and quota exhaustion. Invalid credentials and other configuration errors are surfaced instead of silently switching providers. A short retry is used for explicit OpenAI 429/503 responses; Gemini quota failures are not retried against the same key. If a connection times out after a provider may have accepted the request, fallback can create a second billable request.

Each answer reports the provider and model used, end-to-end LLM response time, and time to first token when streaming exposes it. Speech timing covers local Whisper's segment-processing interval. Azure's continuous recognition API does not expose exact backend compute time, so its displayed interval is measured from first interim text to the finalized transcript. Microphone wait/capture time is excluded.

Run the automated suite with `npm test`. Create production packages with `npm run build`. Cross-platform packaging should be built and checked on each target OS; a Windows build does not verify macOS or Linux packaging/keychain behavior.
