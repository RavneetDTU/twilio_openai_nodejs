// server.js
import express from "express";
import dotenv from "dotenv";
import WebSocket, { WebSocketServer } from "ws";
import bodyParser from "body-parser";
import http from "http";
import cron from "node-cron";
import { BILLYS_STEAKHOUSE_PROMPT } from "./prompt";

// Load environment variables from .env
dotenv.config();

const { OPENAI_API_KEY, PORT = 5050, RENDER_EXTERNAL_URL } = process.env;

if (!OPENAI_API_KEY) {
  console.error("❌ Missing OpenAI API key. Please set it in the .env file.");
  process.exit(1);
}

// Constants
const SYSTEM_MESSAGE = BILLYS_STEAKHOUSE_PROMPT;
const VOICE = "alloy";
const TEMPERATURE = 0.8;

// Loggable OpenAI event types
const LOG_EVENT_TYPES = [
  "error",
  "response.content.done",
  "rate_limits.updated",
  "response.done",
  "input_audio_buffer.committed",
  "input_audio_buffer.speech_stopped",
  "input_audio_buffer.speech_started",
  "session.created",
  "session.updated",
];

// Whether to show elapsed-time math
const SHOW_TIMING_MATH = false;

// Create express app
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Root route
app.get("/", (req, res) => {
  res.json({ message: "Twilio Media Stream Express Server is running!" });
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.status(200).json({ 
    status: "OK", 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage()
  });
});

// Twilio webhook: handle incoming calls
app.all("/incoming-call", (req, res) => {
  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Say voice="Google.en-US-Chirp3-HD-Aoede">
        Please wait while we connect your call to the AI voice assistant, powered by Twilio and the Open A I Realtime API
      </Say>
      <Pause length="1"/>
      <Say voice="Google.en-US-Chirp3-HD-Aoede">O.K. you can start talking!</Say>
      <Connect>
        <Stream url="wss://${req.headers.host}/media-stream" />
      </Connect>
    </Response>`;

  res.type("text/xml");
  res.send(twimlResponse);
});

// Create HTTP server (needed for WebSocket upgrade handling)
const server = http.createServer(app);

// Setup WebSocket server for /media-stream
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  if (request.url === "/media-stream") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

// Handle WebSocket connections from Twilio
wss.on("connection", (connection, req) => {
  console.log("📞 Twilio client connected");

  let streamSid = null;
  let latestMediaTimestamp = 0;
  let lastAssistantItem = null;
  let markQueue = [];
  let responseStartTimestampTwilio = null;

  // Connect to OpenAI Realtime API
  const openAiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview&temperature=${TEMPERATURE}`,
    {
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    }
  );

  // Initialize OpenAI session
  const initializeSession = () => {
    const sessionUpdate = {
      type: "session.update",
      session: {
        type: "realtime",
        model: "gpt-4o-realtime-preview",
        output_modalities: ["audio"],
        audio: {
          input: {
            format: { type: "audio/pcmu" },
            turn_detection: { type: "server_vad" },
          },
          output: { format: { type: "audio/pcmu" }, voice: VOICE },
        },
        instructions: SYSTEM_MESSAGE,
      },
    };

    console.log("🔄 Sending session update:", JSON.stringify(sessionUpdate));
    openAiWs.send(JSON.stringify(sessionUpdate));
  };

  // Speech interruption handling
  const handleSpeechStartedEvent = () => {
    if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
      const elapsedTime = latestMediaTimestamp - responseStartTimestampTwilio;
      if (SHOW_TIMING_MATH)
        console.log(
          `Elapsed time for truncation: ${latestMediaTimestamp} - ${responseStartTimestampTwilio} = ${elapsedTime}ms`
        );

      if (lastAssistantItem) {
        const truncateEvent = {
          type: "conversation.item.truncate",
          item_id: lastAssistantItem,
          content_index: 0,
          audio_end_ms: elapsedTime,
        };
        openAiWs.send(JSON.stringify(truncateEvent));
      }

      connection.send(JSON.stringify({ event: "clear", streamSid }));
      markQueue = [];
      lastAssistantItem = null;
      responseStartTimestampTwilio = null;
    }
  };

  // Send mark event to Twilio
  const sendMark = () => {
    if (streamSid) {
      const markEvent = {
        event: "mark",
        streamSid,
        mark: { name: "responsePart" },
      };
      connection.send(JSON.stringify(markEvent));
      markQueue.push("responsePart");
    }
  };

  // OpenAI WebSocket events
  openAiWs.on("open", () => {
    console.log("✅ Connected to OpenAI Realtime API");
    setTimeout(initializeSession, 100);
  });

  openAiWs.on("message", (data) => {
    try {
      const response = JSON.parse(data);

      if (LOG_EVENT_TYPES.includes(response.type)) {
        console.log(`📩 OpenAI event: ${response.type}`, response);
      }

      if (response.type === "response.output_audio.delta" && response.delta) {
        const audioDelta = {
          event: "media",
          streamSid,
          media: { payload: response.delta },
        };
        connection.send(JSON.stringify(audioDelta));

        if (!responseStartTimestampTwilio) {
          responseStartTimestampTwilio = latestMediaTimestamp;
        }
        if (response.item_id) {
          lastAssistantItem = response.item_id;
        }

        sendMark();
      }

      if (response.type === "input_audio_buffer.speech_started") {
        handleSpeechStartedEvent();
      }
    } catch (err) {
      console.error("❌ Error processing OpenAI msg:", err);
    }
  });

  // Handle incoming Twilio messages
  connection.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);

      switch (data.event) {
        case "media":
          latestMediaTimestamp = data.media.timestamp;
          if (openAiWs.readyState === WebSocket.OPEN) {
            const audioAppend = {
              type: "input_audio_buffer.append",
              audio: data.media.payload,
            };
            openAiWs.send(JSON.stringify(audioAppend));
          }
          break;

        case "start":
          streamSid = data.start.streamSid;
          console.log("🎙️ Stream started:", streamSid);
          responseStartTimestampTwilio = null;
          latestMediaTimestamp = 0;
          break;

        case "mark":
          if (markQueue.length > 0) markQueue.shift();
          break;

        default:
          console.log("ℹ️ Non-media event:", data.event);
          break;
      }
    } catch (err) {
      console.error("❌ Error parsing Twilio msg:", err, msg);
    }
  });

  connection.on("close", () => {
    if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
    console.log("❌ Twilio client disconnected");
  });

  openAiWs.on("close", () => {
    console.log("🔌 Disconnected from OpenAI Realtime API");
  });

  openAiWs.on("error", (err) => {
    console.error("❌ OpenAI WebSocket error:", err);
  });
});

// Health check cron job (runs every 60 seconds)
cron.schedule('*/60 * * * * *', async () => {
  try {
    const baseUrl = RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    const healthUrl = `${baseUrl}/health`;
    
    console.log(`🩺 Running health check: ${healthUrl}`);
    
    const response = await fetch(healthUrl);
    
    if (response.ok) {
      const healthData = await response.json();
      console.log('✅ Health check passed:', {
        status: healthData.status,
        timestamp: healthData.timestamp,
        uptime: Math.round(healthData.uptime)
      });
    } else {
      console.error('❌ Health check failed:', response.status, response.statusText);
    }
  } catch (error) {
    console.error('❌ Health check error:', error.message);
  }
});

console.log('⏰ Health check cron job scheduled to run every 60 seconds');

// Start Express + WebSocket server
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`🩺 Health endpoint available at http://localhost:${PORT}/health`);
  
  if (RENDER_EXTERNAL_URL) {
    console.log(`🌐 External URL: ${RENDER_EXTERNAL_URL}`);
    console.log(`🩺 External Health endpoint: ${RENDER_EXTERNAL_URL}/health`);
  }
});