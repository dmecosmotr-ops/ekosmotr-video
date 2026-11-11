import React, { useEffect, useRef, useState } from 'react';
import { Circle, Info, LoaderCircle, Play, RefreshCw, Square, Video } from 'lucide-react';
import { api } from './api.js';
import { createLiveController } from './liveSession.js';
import { createMsePipeline, supportsLiveMse } from './mediaSourceLive.js';

export default function LivePlayer({ cameraId, cameraName, message, maxStreams = 1, compact = false, videoOnly = false, onController, onPhaseChange, onStart, startBlocked = false, startDisabled = false }) {
  const [view, setView] = useState({ phase: 'idle', error: '', ticket: null });
  const [controller] = useState(() => createLiveController({ cameraId, request: api, onState: setView }));
  const videoRef = useRef(null);
  const ticket = view.ticket;
  const active = Boolean(ticket) || view.phase === 'starting';
  const connecting = view.phase === 'starting' || view.phase === 'connecting';
  const stopping = view.phase === 'stopping';
  const status = view.phase === 'playing' ? 'Прямой эфир' : stopping ? 'Завершаем подключение…' : connecting ? 'Подключаем камеру…' : view.phase === 'error' ? 'Нет соединения' : startBlocked ? 'Лимит эфира заполнен' : 'Просмотр остановлен';
  const startLabel = view.phase === 'error' ? 'Повторить подключение' : 'Начать просмотр';
  const start = () => onStart ? onStart(cameraId) : controller.start();

  useEffect(() => () => controller.dispose(), [controller]);
  useEffect(() => {
    onController?.(cameraId, controller);
    return () => onController?.(cameraId, null);
  }, [cameraId, controller, onController]);
  useEffect(() => { onPhaseChange?.(cameraId, view.phase); }, [cameraId, view.phase, onPhaseChange]);
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !ticket) return;
    if (supportsLiveMse()) {
      const pipeline = createMsePipeline({ video, url: ticket.streamUrl,
        onError: message => controller.fail(message, ticket.sessionId) });
      return () => pipeline.dispose();
    }
    video.src = ticket.streamUrl;
    return () => {
      video.pause();
      video.removeAttribute('src');
      video.load();
    };
  }, [ticket?.sessionId]);

  return <div className={`live-player ${compact ? 'live-player-compact' : ''}`}>
    <div className="live-toolbar">
      <div className={`live-state is-${view.phase}`} role="status" title={view.error || status}>
        {connecting || stopping ? <LoaderCircle size={15} className="spin" /> : <Circle size={9} fill={view.phase === 'playing' ? 'currentColor' : 'none'} />}
        <span>{status}</span>
      </div>
      {stopping ? <button type="button" className="button button-secondary" disabled aria-label="Останавливаем…"><LoaderCircle size={14} className="spin" /><span>Останавливаем…</span></button> : active ? <button type="button" className="button button-secondary" aria-label="Остановить" title="Остановить" onClick={() => controller.stop()}><Square size={14} /><span>Остановить</span></button>
        : <button type="button" className="button button-primary" aria-label={startLabel} title={startBlocked ? 'Лимит эфира заполнен' : startLabel} disabled={startBlocked || startDisabled} onClick={start}>{view.phase === 'error' ? <RefreshCw size={15} /> : <Play size={15} />}<span>{startLabel}</span></button>}
    </div>
    {view.error && <div className="error-notice" role="alert">{view.error}</div>}
    {ticket ? <div className="video-wrap live-video-wrap">
      <video ref={videoRef} key={ticket.sessionId} autoPlay muted playsInline controls={!videoOnly} preload="auto" aria-label={`Прямой эфир: ${cameraName}`}
        onPlaying={() => controller.playing(ticket.sessionId)}
        onError={() => controller.fail('Не удалось открыть прямой эфир. Камера могла отключиться или соединение прервалось. Повторите подключение.', ticket.sessionId)}
        onEnded={() => controller.fail('Просмотр завершён. Для нового сеанса нажмите «Повторить подключение».', ticket.sessionId)} />
      <div className="video-caption">{view.phase === 'playing' ? 'Онлайн' : 'Ожидаем первые кадры'} · {cameraName}</div>
    </div> : <div className="playback-empty live-idle"><Video size={31} strokeWidth={1.3} /><strong>{view.phase === 'starting' ? 'Запрашиваем подключение' : stopping ? 'Закрываем видеосеанс' : startBlocked ? 'Нет свободного места для эфира' : 'Камера готова к запросу видео'}</strong><p>{view.phase === 'starting' ? 'Подключение может занять до двух минут.' : stopping ? 'Дождитесь завершения подключения перед новым просмотром.' : startBlocked ? 'Остановите одну из камер, чтобы запустить эту.' : message || 'Нажмите «Начать просмотр», чтобы получить текущее изображение с камеры.'}</p></div>}
    {connecting && ticket && <div className="live-connecting-note">Подключение может занять до двух минут. Изображение появится после получения первых кадров.</div>}
    {!compact && <div className="live-limit-note"><Info size={14} /><span>До {maxStreams} {maxStreams === 1 ? 'камеры' : 'камер'} одновременно, до 10 минут за сеанс. Кнопка «Остановить», смена вкладки или закрытие карточки завершают подключение.</span></div>}
  </div>;
}
