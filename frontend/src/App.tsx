import React, { useState } from 'react';
import './App.css';
import VoiceRecorder from './Components/VoiceRecorder';
import TranslationDisplay from './Components/TranslationDisplay';

function App() {
  const [transcript, setTranscript] = useState<string[]>([]);

  return (
    <div className="App">
      <h1>Voice Translation App</h1>
      <VoiceRecorder setTranscript={setTranscript} />
      <TranslationDisplay transcript={transcript} />
    </div>
  );
}

export default App;
