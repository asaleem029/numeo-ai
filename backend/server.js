const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();
const app = express();
const server = http.createServer(app);
const NUMEO_OPENAI_API_KEY = process.env.NUMEO_OPENAI_API_KEY;

const MAX_RETRIES = 5; // Max retry attempts
const RETRY_DELAY = 2000; // Starting delay in milliseconds
const MAX_BACKOFF = 30000; // Maximum backoff time (30 seconds)

// Enable CORS for express
app.use(
  cors({
    origin: 'http://localhost:3000', // Allow the frontend running on localhost:3000
    methods: ['GET', 'POST'],
    credentials: true,
  })
);

// Configure Socket.IO with CORS support
const io = socketIo(server, {
  cors: {
    origin: 'http://localhost:3000', // Allow the frontend to connect
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

// Basic route to check if the server is running
app.get('/', (req, res) => {
  res.send('Server is running');
});

// Function to make API request with retry logic
const fetchAudioTranscription = async (audioData, retries = 0) => {
  try {
    const response = await axios.post(
      'https://api.openai.com/v1/audio/transcriptions',
      {
        model: 'whisper-1',
        audio: {
          audio: audioData, // Ensure the audio data is properly encoded as base64
        },
      },
      {
        headers: {
          Authorization: `Bearer ${NUMEO_OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    return response.data.text || 'No text found in response';
  } catch (error) {
    if (
      error.response &&
      error.response.status === 429 &&
      retries < MAX_RETRIES
    ) {
      // Rate limit exceeded, retry with exponential backoff
      console.log(`Rate limit exceeded. Retrying... Attempt ${retries + 1}`);

      const backoffDelay = Math.min(
        RETRY_DELAY * Math.pow(2, retries),
        MAX_BACKOFF
      );
      console.log(
        `Waiting for ${backoffDelay / 1000} seconds before retrying...`
      );

      // Wait for the backoff time
      await new Promise((resolve) => setTimeout(resolve, backoffDelay));

      return fetchAudioTranscription(audioData, retries + 1);
    }

    // If we've exhausted retries or hit an error that isn't rate limit, log and throw
    console.error('Error with AI API:', error);
    throw new Error('Translation failed due to an error.');
  }
};

// Handle socket connection and audio events
io.on('connection', (socket) => {
  console.log('a user connected');

  socket.on('audio', async (audioData) => {
    try {
      // Validate audio data
      if (!audioData) {
        socket.emit('translatedText', 'No audio data received.');
        return;
      }

      console.log('Received audio data.');

      // Get transcription from OpenAI API with retry logic
      const translatedText = await fetchAudioTranscription(audioData);

      // Send the translated text back to the frontend
      socket.emit('translatedText', translatedText);
    } catch (error) {
      socket.emit('translatedText', error.message || 'Translation failed');
    }
  });

  socket.on('disconnect', () => {
    console.log('user disconnected');
  });
});

// Start the server and listen on port 5000
server.listen(5000, () => {
  console.log('Server listening on port 5000');
});
