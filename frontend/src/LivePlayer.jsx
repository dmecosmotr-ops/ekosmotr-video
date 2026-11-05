import React, { useEffect, useRef, useState } from 'react';
import { Circle, Info, LoaderCircle, Play, RefreshCw, Square, Video } from 'lucide-react';
import { api } from './api.js';
import { createLiveController } from './liveSession.js';
import { createMsePipeline, supportsLiveMse } from './mediaSourceLive.js';

export default function LivePlayer({ cameraId, cameraName, message }) {
  const [view, setView] = useState({ phase: 'idle', error: '', ticket: null });
  const [controller] = useState(() => createLiveController({ cameraId, request: api, onState: setView }));
  const videoRef = useRef(null);
  const ticket = view.ticket;
  const active = Boolean(ticket) || view.phase === 'starting';
  const connecting = view.phase === 'starting' || view.phase === 'connecting';
  const stopping = view.phase === 'stopping';

  useEffect(() => () => controller.dispose(), [controller]);
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

  return <div className="live-player">
    <div className="live-toolbar">
      <div className={`live-state ${view.phase === 'playing' ? 'is-playing' : ''}`} role="status">
        {connecting || stopping ? <LoaderCircle size={15} className="spin" /> : <Circle size={9} fill={view.phase === 'playing' ? 'currentColor' : 'none'} />}
        {view.phase === 'playing' ? 'Прямой эфир' : stopping ? 'Завершаем подключение…' : connecting ? 'Подключаем камеру…' : 'Просмотр остановлен'}
      </div>
      {stopping ? <button type="button" className="button button-secondary" disabled><LoaderCircle size={14} className="spin" />Останавливаем…</button> : active ? <button type="button" className="button button-secondary" onClick={() => controller.stop()}><Square size={14} />Остановить</button>
        : <button type="button" className="button button-primary" onClick={() => controller.start()}>{view.phase === 'error' ? <RefreshCw size={15} /> : <Play size={15} />}{view.phase === 'error' ? 'Повторить подключение' : 'Начать просмотр'}</button>}
    </div>
    {view.error && <div className="error-notice" role="alert">{view.error}</div>}
    {ticket ? <div className="video-wrap live-video-wrap">
      <video ref={videoRef} key={ticket.sessionId} autoPlay muted playsInline controls preload="auto" aria-label={`Прямой эфир: ${cameraName}`}
        onPlaying={() => controller.playing(ticket.sessionId)}
        onError={() => controller.fail('Не удалось открыть прямой эфир. Камера могла отключиться или соединение прервалось. Повторите подключение.', ticket.sessionId)}
        onEnded={() => controller.fail('Просмотр завершён. Для нового сеанса нажмите «Повторить подключение».', ticket.sessionId)} />
      <div className="video-caption">{view.phase === 'playing' ? 'Онлайн' : 'Ожидаем первые кадры'} · {cameraName}</div>
    </div> : <div className="playback-empty live-idle"><Video size={31} strokeWidth={1.3} /><strong>{view.phase === 'starting' ? 'Запрашиваем подключение' : stopping ? 'Закрываем видеосеанс' : 'Камера готова к запросу видео'}</strong><p>{view.phase === 'starting' ? 'Подключение может занять до двух минут.' : stopping ? 'Дождитесь завершения подключения перед новым просмотром.' : message || 'Нажмите «Начать просмотр», чтобы получить текущее изображение с камеры.'}</p></div>}
    {connecting && ticket && <div className="live-connecting-note">Подключение может занять до двух минут. Изображение появится после получения первых кадров.</div>}
    <div className="live-limit-note"><Info size={14} /><span>Тестовый режим: одна камера одновременно, до 10 минут за сеанс. Кнопка «Остановить», смена вкладки или закрытие карточки завершают подключение.</span></div>
  </div>;
}
