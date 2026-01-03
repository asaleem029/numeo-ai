import React from 'react';
import './TranslationDisplay.css';

const TranslationDisplay = ({ transcript }: { transcript: string[] }) => {
    return (
        <div className="translation-display">
            <h3>Translated Text:</h3>
            <ul>
                {transcript.map((text, index) => (
                    <li key={index}>{text}</li>
                ))}
            </ul>
        </div>
    );
};

export default TranslationDisplay;
