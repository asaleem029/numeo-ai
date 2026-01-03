import React, { useState, useEffect, useRef } from 'react';
import io from 'socket.io-client';  // Fixed import for socket.io-client
import './VoiceRecorder.css';  // Ensure you have the correct CSS declaration

const VoiceRecorder = ({ setTranscript }: { setTranscript: React.Dispatch<React.SetStateAction<string[]>> }) => {
    const [isRecording, setIsRecording] = useState(false);
    const [isTranslating, setIsTranslating] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const socketRef = useRef<any>(null);

    useEffect(() => {
        // Connect to the backend WebSocket server
        socketRef.current = io('http://localhost:5000');

        socketRef.current.on('translatedText', (data: { translatedText: string }) => {
            setIsTranslating(false);
            setTranscript((prev) => [...prev, data.translatedText]);
        });

        socketRef.current.on('error', (errorMessage: string) => {
            setIsTranslating(false);
            setError(errorMessage);
        });

        // Clean up on unmount
        return () => {
            if (socketRef.current) {
                socketRef.current.disconnect();
            }
        };
    }, []);

    const startRecording = () => {
        if (navigator.mediaDevices) {
            navigator.mediaDevices
                .getUserMedia({ audio: true })
                .then((stream) => {
                    mediaRecorderRef.current = new MediaRecorder(stream);
                    mediaRecorderRef.current.ondataavailable = handleDataAvailable;
                    mediaRecorderRef.current.start();
                    setIsRecording(true);
                    setError(null); // Reset any previous errors
                })
                .catch((err) => {
                    console.error('Error accessing microphone:', err);
                    setError('Error accessing microphone');
                });
        }
    };

    const stopRecording = () => {
        if (mediaRecorderRef.current) {
            mediaRecorderRef.current.stop();
            setIsRecording(false);
            setIsTranslating(true);
        }
    };

    const handleDataAvailable = (event: any) => {
        const audioBlob = event.data;
        const reader = new FileReader();
        reader.onloadend = () => {
            const base64Audio = reader.result as string;
            socketRef.current.emit('audio', { audio: base64Audio });
        };
        reader.readAsDataURL(audioBlob);
    };

    return (
        <div className="voice-recorder">
            <div className="controls">
                <button onClick={isRecording ? stopRecording : startRecording} className="record-btn">
                    {isRecording ? 'Stop Recording' : 'Start Recording'}
                </button>
            </div>
            {isTranslating && <div className="loading">Translating...</div>}
            {error && <div className="error">{error}</div>}
        </div>
    );
};

export default VoiceRecorder;
