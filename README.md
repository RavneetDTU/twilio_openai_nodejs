# OpenAI Realtime + Twilio Voice Media Streams

Realtime voice assistant that:
- Answers a phone call via Twilio
- Streams caller audio to OpenAI Realtime WebSocket (PCMU / μ-law)
- Streams synthesized assistant audio back to the caller in (near) realtime
- Performs server‑side VAD based interruption (barge‑in) and truncates AI audio

## Folder Structure
```
openai-realtime-twilio/
├─ server.js              # Express + WebSocket bridge (Twilio <-> OpenAI)
├─ package.json
├─ requirement.txt        # (Node deps listed for reference; not a Python project)
├─ .gitignore
├─ README.md
└─ (create) .env          # Your secrets (not committed)
```

## Tech Stack
- Node.js (ES Modules)
- Express 5
- ws (WebSocket server & OpenAI client)
- Twilio Programmable Voice (Media Streams)
- OpenAI Realtime API (model: gpt-realtime)
- body-parser, dotenv, nodemon (dev)

## Data / Audio Flow
Caller (PSTN) → Twilio Voice → Twilio Media Stream (WebSocket) → server.js → OpenAI Realtime API  
Assistant audio (base64 μ-law frames) ← OpenAI Realtime ← server.js ← Twilio Stream ← back to caller

## Realtime Behaviors
- Twilio sends events: start, media, mark, etc.
- Each media event contains base64 PCMU frame; forwarded via input_audio_buffer.append.
- OpenAI sends response.output_audio.delta chunks; relayed to Twilio as media events.
- Barge‑in: when OpenAI detects caller speech (input_audio_buffer.speech_started), server truncates the in‑flight assistant response using conversation.item.truncate and clears buffered audio marks.

## Requirements
- Node.js ≥ 18
- A Twilio account with a Voice phone number
- OpenAI API key with Realtime access
- Publicly reachable HTTPS endpoint (use ngrok for local dev)

## Environment Variables (.env)
```
OPENAI_API_KEY=sk-...
PORT=5050
```

## Installation
```
git clone <repo-url>
cd openai-realtime-twilio
npm install
cp .env.example .env  (if you create one)  # then edit OPENAI_API_KEY
```

(If no .env.example exists, just create .env manually.)

## Run (Local)
Development (auto-reload):
```
npm run dev
```
Production style:
```
npm start
```
Expose port to Twilio (in new terminal):
```
ngrok http 5050
```
Copy the https://<random>.ngrok-free.app domain.

## Configure Twilio
1. Buy / use a Twilio Voice number.
2. In the number Voice configuration:
   - Voice & Fax → A CALL COMES IN → Webhook
   - URL: https://<your-ngrok-domain>/incoming-call
   - Method: HTTP POST (any works; route uses app.all)
3. Save.

When you call the number:
- Twilio fetches /incoming-call (gets TwiML)
- TwiML instructs Twilio Media Stream: `<Stream url="wss://<host>/media-stream" />`
- Twilio opens WebSocket → server upgrades at /media-stream
- Audio packets stream bi‑directionally

## HTTP Endpoints
### GET /
Health check.
Response:
```
{ "message": "Twilio Media Stream Express Server is running!" }
```

### ALL /incoming-call
Returns TwiML to:
- Play greeting
- Start Media Stream to wss://<host>/media-stream

No request body required. Example response snippet:
```
<Response>
  <Say>...</Say>
  <Connect>
    <Stream url="wss://YOUR_DOMAIN/media-stream" />
  </Connect>
</Response>
```

## WebSocket (Twilio -> Server) /media-stream
Twilio sends JSON messages:
- start
- media (base64 PCMU frames)
- mark
- stop (on hangup)

Server sends back:
- media (assistant audio frames from OpenAI)
- mark (synchronization)
- clear (signal to reset buffered playback after truncation)

## OpenAI Realtime Messages (Selected)
Sent by server:
- session.update (initial configuration: model, modalities, voice, VAD)
- input_audio_buffer.append (caller audio)
- conversation.item.truncate (on barge‑in)

Received and used:
- response.output_audio.delta (assistant audio chunks)
- input_audio_buffer.speech_started / speech_stopped
- response.done / error (logged)

## Key Constants (server.js)
- SYSTEM_MESSAGE: Assistant persona
- VOICE: alloy (changeable)
- TEMPERATURE: 0.8
- SHOW_TIMING_MATH: toggle debug timing logs

## Barge‑In Logic
1. Track latestMediaTimestamp from Twilio frames.
2. On first assistant audio delta, record responseStartTimestampTwilio.
3. If caller speech event arrives (speech_started):
   - Compute elapsed audio (for truncation)
   - Send conversation.item.truncate to OpenAI
   - Send clear to Twilio client
   - Reset assistant tracking

## Changing the Voice
Adjust VOICE constant (server.js). Available voices depend on OpenAI offerings. Keep audio format: PCMU to match Twilio.

## Error Handling
- Missing OPENAI_API_KEY → process exit
- WebSocket errors logged (OpenAI / Twilio)
- JSON parsing guarded with try/catch

## Extending
Ideas:
- Add transcript capture (store streaming text when enabling text modality)
- Add analytics (response latency, barge‑in counts)
- Add auth layer for webhook
- Support multiple simultaneous calls (current code is stateless per connection and already supports it)

## Security Notes
- Do not log raw audio payloads in production.
- Restrict who can reach /incoming-call if repurposed for non-Twilio clients.
- Use HTTPS (Twilio requires TLS).

## Troubleshooting
- Silence / no audio: verify ngrok URL is HTTPS; confirm media events arriving (add temporary console logs).
- 403 from OpenAI: check model availability & key scope.
- No barge‑in: ensure server_vad active (in session.update) and user actually interrupts early.

## Scripts
- npm run dev → nodemon server.js
- npm start → node server.js

## License
ISC (adjust as needed).

## Disclaimer
This repository uses a requirement.txt only as a plain listing of Node dependencies; it is not a Python environment file.
