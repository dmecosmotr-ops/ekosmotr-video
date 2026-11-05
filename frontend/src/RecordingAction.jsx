import React from 'react';
import { Film } from 'lucide-react';
import { clock } from './playbackHelpers.js';
import { recordingAction } from './eventsPresentation.js';
import './events.css';

export default function RecordingAction({ event, camera, onRecord }) {
  const action = recordingAction(camera);
  if (!action.actionable || !onRecord) {
    return <span className="recording-unavailable" title={!camera ? 'Камера этого события недоступна' : undefined}>{!camera ? 'Камера события недоступна' : action.label}</span>;
  }
  return <button type="button" className="text-button event-recording-action" aria-label={`${action.label}: ${event.label || 'событие'}, ${clock(event.time, true)}`} onClick={() => onRecord(event)}><Film size={14} aria-hidden="true" /><span>{action.label}</span></button>;
}
