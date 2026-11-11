import React, { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { ErrorNotice, Spinner } from './components.jsx';

const loadEngine = async () => {
  const [engine, worker] = await Promise.all([
    import('pdfjs-dist/build/pdf.mjs'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ]);
  engine.GlobalWorkerOptions.workerSrc = worker.default;
  return engine;
};

function viewportPoint(viewport, x, y) {
  const [a, b, c, d, e, f] = viewport.transform;
  return [a * x + c * y + e, b * x + d * y + f];
}

function linkPosition(rectangle, viewport) {
  const [x1, y1] = viewportPoint(viewport, rectangle[0], rectangle[1]);
  const [x2, y2] = viewportPoint(viewport, rectangle[2], rectangle[3]);
  return {
    left: `${100 * Math.min(x1, x2) / viewport.width}%`,
    top: `${100 * Math.min(y1, y2) / viewport.height}%`,
    width: `${100 * Math.abs(x1 - x2) / viewport.width}%`,
    height: `${100 * Math.abs(y1 - y2) / viewport.height}%`,
  };
}

function scrollToLocation(scroller, sheet, viewport, location) {
  const point = location ? viewportPoint(viewport, location.x, location.y) : [0, 0];
  scroller.scrollTop = location ? sheet.offsetTop + point[1] - 12 : 0;
}

export function PdfReportPreview({ url }) {
  const [pdf, setPdf] = useState(null);
  const [page, setPage] = useState(1);
  const [width, setWidth] = useState(0);
  const [rendered, setRendered] = useState(null);
  const [error, setError] = useState('');
  const [linkError, setLinkError] = useState('');
  const scroller = useRef(null);
  const sheet = useRef(null);
  const canvas = useRef(null);
  const destination = useRef(null);
  const linkRequest = useRef(0);

  useEffect(() => {
    let task;
    let active = true;
    loadEngine().then(engine => {
      if (!active) return null;
      task = engine.getDocument({ url, useWasm: false, enableXfa: false });
      return task.promise;
    }).then(document => {
      if (active) setPdf(document);
    }).catch(() => {
      if (active) setError('Не удалось открыть PDF. Проверьте доступ или попробуйте открыть его в новой вкладке.');
    });
    return () => {
      active = false;
      linkRequest.current++;
      task?.destroy().catch(() => {});
    };
  }, [url]);

  useEffect(() => {
    if (!pdf) return;
    const area = sheet.current;
    const measure = () => setWidth(area.clientWidth);
    const observer = new ResizeObserver(measure);
    observer.observe(area);
    measure();
    return () => observer.disconnect();
  }, [pdf]);

  useEffect(() => {
    if (!pdf || !width) return;
    let active = true;
    let renderTask;
    setRendered(null);
    setError('');
    pdf.getPage(page).then(async pdfPage => {
      if (!active) return;
      const viewport = pdfPage.getViewport({ scale: width / pdfPage.getViewport({ scale: 1 }).width });
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(8_000_000 / (viewport.width * viewport.height)));
      const surface = canvas.current;
      surface.width = Math.ceil(viewport.width * pixelRatio);
      surface.height = Math.ceil(viewport.height * pixelRatio);
      renderTask = pdfPage.render({ canvas: surface, canvasContext: surface.getContext('2d'), viewport,
        transform: [pixelRatio, 0, 0, pixelRatio, 0, 0] });
      const [, annotations] = await Promise.all([
        renderTask.promise,
        pdfPage.getAnnotations({ intent: 'display' }).catch(() => []),
      ]);
      if (!active) return;
      setRendered({ page, viewport, links: annotations.filter(item => item.subtype === 'Link' && item.dest
        && Array.isArray(item.rect) && item.rect.length === 4 && item.rect.every(Number.isFinite)) });
    }).catch(() => {
      if (active) setError('Не удалось отобразить страницу PDF. Можно перейти на другую страницу или открыть файл в новой вкладке.');
    });
    return () => { active = false; renderTask?.cancel(); };
  }, [pdf, page, width]);

  useEffect(() => {
    if (!rendered || !destination.current || destination.current.page !== rendered.page) return;
    scrollToLocation(scroller.current, sheet.current, rendered.viewport, destination.current.location);
    destination.current = null;
  }, [rendered]);

  const turnPage = next => {
    linkRequest.current++;
    destination.current = null;
    setLinkError('');
    setPage(next);
    scroller.current.scrollTop = 0;
  };

  const followLink = async link => {
    const request = ++linkRequest.current;
    setLinkError('');
    try {
      const target = typeof link === 'string' ? await pdf.getDestination(link) : link;
      if (!Array.isArray(target) || target[0] == null) throw new Error('PDF destination is missing');
      const index = Number.isInteger(target[0]) ? target[0] : await pdf.getPageIndex(target[0]);
      if (request !== linkRequest.current) return;
      const next = index + 1;
      if (next < 1 || next > pdf.numPages) throw new Error('PDF destination is out of range');
      const kind = target[1]?.name;
      const y = kind === 'XYZ' ? target[3] : ['FitH', 'FitBH'].includes(kind) ? target[2] : kind === 'FitR' ? target[5] : null;
      const location = Number.isFinite(y) ? { x: kind === 'XYZ' && Number.isFinite(target[2]) ? target[2] : 0, y } : null;
      if (next === page && rendered) scrollToLocation(scroller.current, sheet.current, rendered.viewport, location);
      else { destination.current = { page: next, location }; setPage(next); }
    } catch {
      if (request === linkRequest.current) setLinkError('Не удалось перейти по ссылке в отчёте. Выберите страницу вручную.');
    }
  };

  if (!pdf) return error ? <div className="microphones-pdf-error"><ErrorNotice message={error} /></div> : <Spinner label="Открываем PDF…" />;
  const current = rendered?.page === page ? rendered : null;
  return <div className="microphones-pdf">
    <div className="microphones-pdf-controls" role="group" aria-label="Страницы отчёта">
      <button type="button" className="icon-button" aria-label="Предыдущая страница PDF" onClick={() => turnPage(page - 1)} disabled={page === 1}><ChevronLeft size={19} /></button>
      <label>Страница <select value={page} onChange={event => turnPage(Number(event.target.value))} aria-label="Страница PDF">{Array.from({ length: pdf.numPages }, (_, index) => <option value={index + 1} key={index + 1}>{index + 1}</option>)}</select> из {pdf.numPages}</label>
      <button type="button" className="icon-button" aria-label="Следующая страница PDF" onClick={() => turnPage(page + 1)} disabled={page === pdf.numPages}><ChevronRight size={19} /></button>
    </div>
    {linkError && <div className="microphones-pdf-error"><ErrorNotice message={linkError} /></div>}
    <div className="microphones-pdf-scroll" ref={scroller}>
      {!current && !error && <Spinner label="Загружаем страницу PDF…" />}
      {error && <ErrorNotice message={error} />}
      <div className="microphones-pdf-sheet" ref={sheet}>
        <canvas ref={canvas} style={{ display: current ? 'block' : 'none' }} role="img" aria-label={`Страница ${page} из ${pdf.numPages}`} />
        {current?.links.map(link => <button type="button" className="microphones-pdf-link" key={link.id} style={linkPosition(link.rect, current.viewport)} aria-label="Перейти по ссылке в отчёте" onClick={() => followLink(link.dest)} />)}
      </div>
    </div>
  </div>;
}
