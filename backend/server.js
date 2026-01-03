const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const axios = require('axios');
const cors = require('cors');
const FormData = require('form-data');
require('dotenv').config();
const app = express();
const server = http.createServer(app);
const NUMEO_OPENAI_API_KEY = process.env.NUMEO_OPENAI_API_KEY;

const MAX_RETRIES = 10; // Max retry attempts for rate limits
const MAX_NETWORK_RETRIES = 3; // Max retry attempts for network/DNS errors
const RETRY_DELAY = 2000; // Starting delay in milliseconds
const MAX_BACKOFF = 300000; // Maximum backoff time (5 minutes)
const MAX_NETWORK_BACKOFF = 10000; // Maximum backoff for network errors (10 seconds)

// Simple request queue to prevent too many simultaneous requests
const requestQueue = [];
let isProcessingQueue = false;

// Process the request queue one at a time
const processQueue = async () => {
  if (isProcessingQueue || requestQueue.length === 0) {
    return;
  }

  isProcessingQueue = true;
  
  while (requestQueue.length > 0) {
    const { audioData, resolve, reject } = requestQueue.shift();
    
    try {
      const result = await fetchAudioTranscription(audioData);
      resolve(result);
    } catch (error) {
      reject(error);
    }
    
    // Small delay between requests to avoid rate limits
    if (requestQueue.length > 0) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  isProcessingQueue = false;
};

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

// Helper function to convert various audio data formats to Buffer
const audioDataToBuffer = (audioData) => {
  // If it's already a Buffer, return it
  if (Buffer.isBuffer(audioData)) {
    return audioData;
  }

  // If it's an object, try to extract the audio data
  if (typeof audioData === 'object' && audioData !== null) {
    // Handle nested structure like {audio: {audio: "data:..."}}
    if (audioData.audio) {
      return audioDataToBuffer(audioData.audio);
    }
    // Handle direct object with base64 property
    if (audioData.data) {
      return audioDataToBuffer(audioData.data);
    }
    // If object has a string value, try to extract it
    const stringValue = Object.values(audioData).find(v => typeof v === 'string');
    if (stringValue) {
      return audioDataToBuffer(stringValue);
    }
  }

  // If it's a string, handle data URI or plain base64
  if (typeof audioData === 'string') {
    // Check if it's a data URI (starts with "data:")
    if (audioData.startsWith('data:')) {
      // Remove data URI prefix (e.g., "data:audio/webm;codecs=opus;base64,")
      const base64Data = audioData.split(',')[1] || audioData;
      const buffer = Buffer.from(base64Data, 'base64');
      console.log(`Converted data URI to buffer: ${buffer.length} bytes`);
      return buffer;
    } else {
      // Assume it's plain base64
      const buffer = Buffer.from(audioData, 'base64');
      console.log(`Converted base64 string to buffer: ${buffer.length} bytes`);
      return buffer;
    }
  }

  // If we can't convert it, throw an error
  throw new Error(`Unsupported audio data format: ${typeof audioData}`);
};

// Function to make API request with retry logic
const fetchAudioTranscription = async (audioData, retries = 0) => {
  try {
    // Convert audio data to buffer (handles various formats)
    const audioBuffer = audioDataToBuffer(audioData);
    
    // Create FormData for multipart/form-data request
    const formData = new FormData();
    formData.append('model', 'whisper-1');
    formData.append('file', audioBuffer, {
      filename: 'audio.webm',
      contentType: 'audio/webm',
    });

    const response = await axios.post(
      'https://api.openai.com/v1/audio/transcriptions',
      formData,
      {
        headers: {
          Authorization: `Bearer ${NUMEO_OPENAI_API_KEY}`,
          ...formData.getHeaders(),
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: 60000, // 60 second timeout
      }
    );

    return response.data.text || 'No text found in response';
  } catch (error) {
    // Check if it's a rate limit error
    const isRateLimit = error.response && error.response.status === 429;
    
    // Check if it's a DNS error (most persistent network issue)
    const isDNSError = 
      error.code === 'EAI_AGAIN' || 
      error.code === 'ENOTFOUND' ||
      (error.message && error.message.includes('getaddrinfo'));
    
    // Check if it's a network error (connection, timeout, etc.)
    const isNetworkError = 
      isDNSError ||
      error.code === 'ECONNRESET' || 
      error.code === 'ETIMEDOUT' ||
      (error.message && (
        error.message.includes('ECONNRESET') ||
        error.message.includes('ETIMEDOUT')
      ));

    // Determine max retries based on error type
    const maxRetries = isDNSError ? MAX_NETWORK_RETRIES : (isRateLimit ? MAX_RETRIES : MAX_NETWORK_RETRIES);

    // Retry for rate limits or network errors
    if ((isRateLimit || isNetworkError) && retries < maxRetries) {
      const errorType = isRateLimit ? 'Rate limit' : (isDNSError ? 'DNS resolution' : 'Network');
      console.log(`${errorType} error encountered. Retrying... Attempt ${retries + 1}/${maxRetries}`);

      // Calculate backoff delay
      let backoffDelay = RETRY_DELAY * Math.pow(2, retries);
      
      // For rate limits, check Retry-After header (case-insensitive)
      if (isRateLimit && error.response) {
        const retryAfter = 
          error.response.headers['retry-after'] || 
          error.response.headers['Retry-After'] ||
          error.response.headers['RETRY-AFTER'];
        
        if (retryAfter) {
          // Use the retry-after header value (in seconds) if available
          backoffDelay = parseInt(retryAfter) * 1000;
          console.log(`API suggests waiting ${backoffDelay / 1000} seconds (from Retry-After header)`);
        } else {
          // Use exponential backoff with longer delays for rate limits
          backoffDelay = Math.min(backoffDelay, MAX_BACKOFF);
          console.log(`Waiting for ${backoffDelay / 1000} seconds before retrying...`);
        }
      } else if (isNetworkError) {
        // For network/DNS errors, use shorter exponential backoff
        backoffDelay = Math.min(backoffDelay, MAX_NETWORK_BACKOFF);
        console.log(`${isDNSError ? 'DNS' : 'Network'} error. Waiting for ${backoffDelay / 1000} seconds before retrying...`);
      }

      // Add jitter to prevent thundering herd problem
      const jitter = Math.random() * 1000; // Random 0-1 second
      const maxDelay = isNetworkError ? MAX_NETWORK_BACKOFF : MAX_BACKOFF;
      backoffDelay = Math.min(backoffDelay + jitter, maxDelay);

      // Wait for the backoff time
      await new Promise((resolve) => setTimeout(resolve, backoffDelay));

      return fetchAudioTranscription(audioData, retries + 1);
    }

    // If we've exhausted retries
    if (retries >= maxRetries) {
      let errorMsg;
      if (isDNSError) {
        errorMsg = 'Translation failed: Unable to connect to OpenAI API. Please check your internet connection and DNS settings.';
      } else if (isRateLimit) {
        errorMsg = 'Translation failed: Rate limit exceeded after multiple retries. Please wait a few minutes and try again.';
      } else if (isNetworkError) {
        errorMsg = 'Translation failed: Network error after multiple retries. Please check your internet connection and try again.';
      } else {
        errorMsg = 'Translation failed after multiple retries.';
      }
      
      console.error(`Error with AI API after ${maxRetries} retries:`, {
        status: error.response?.status,
        statusText: error.response?.statusText,
        message: error.message,
        code: error.code,
        data: error.response?.data
      });
      throw new Error(errorMsg);
    }
    
    // For other errors, throw immediately
    console.error('Error with AI API:', {
      status: error.response?.status,
      statusText: error.response?.statusText,
      message: error.message,
      code: error.code,
      data: error.response?.data
    });
    
    const errorMessage = error.response?.data?.error?.message || error.message || 'Translation failed due to an error.';
    throw new Error(errorMessage);
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
      console.log('Audio data type:', typeof audioData);
      console.log('Audio data is Buffer:', Buffer.isBuffer(audioData));
      if (typeof audioData === 'object' && audioData !== null) {
        console.log('Audio data keys:', Object.keys(audioData));
      }

      // Queue the request to prevent too many simultaneous API calls
      const translatedText = await new Promise((resolve, reject) => {
        requestQueue.push({ audioData, resolve, reject });
        processQueue();
      });

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
