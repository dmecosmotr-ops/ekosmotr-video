import { fstatSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { opaqueId, openSafeFile } from './analysis.mjs';
import { validDate } from './playback.mjs';

const PRODUCTS = ['first_aid_kit', 'fire_extinguisher', 'warning_triangle', 'license_plate_frames'];
const COUNTS = ['offerEpisodes', 'sales'];
const STATUSES = ['ready', 'processing', 'missing'];
const PDF_SIGNATURE = Buffer.from('%PDF-');
const MAX_CATALOG_BYTES = 4 * 1024 * 1024;
const MAX_PDF_BYTES = 64 * 1024 * 1024;
const MAX_SHIFTS = 10_000;

const objectWith = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => keys.includes(key));
const count = value => value == null || (Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000);
const byProduct = fn => Object.fromEntries(PRODUCTS.map(key => [key, fn(key)]));
const byCount = fn => Object.fromEntries(COUNTS.map(key => [key, fn(key)]));

function inside(path, root) {
  const child = relative(root, path);
  return !child || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

export function validateMicrophoneDirectory(dir, staticDir) {
  if (dir === undefined) return undefined;
  if (typeof dir !== 'string' || !isAbsolute(dir) || dir.includes('\0'))
    throw new Error('PILOT_MICROPHONE_DIR must be an absolute path');
  const real = path => {
    try { return realpathSync(path); } catch { return resolve(path); }
  };
  const root = resolve(dir), webRoot = resolve(staticDir);
  if (inside(root, webRoot) || inside(webRoot, root)
    || inside(real(root), real(webRoot)) || inside(real(webRoot), real(root)))
    throw new Error('PILOT_MICROPHONE_DIR must be separate from the public frontend directory');
  return root;
}

function readCatalogFile(root) {
  const opened = openSafeFile(root, 'catalog.json', MAX_CATALOG_BYTES);
  if (!opened) return null;
  try {
    const bytes = Buffer.alloc(opened.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const length = readSync(opened.fd, bytes, offset, bytes.length - offset, null);
      if (!length) break;
      offset += length;
    }
    const after = fstatSync(opened.fd);
    if (offset !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.info.mtimeMs) return null;
    return JSON.parse(bytes.subarray(0, offset).toString('utf8').replace(/^\uFEFF/, ''));
  } catch { return null; } finally { opened.close(); }
}

function validCounts(value) {
  return objectWith(value, COUNTS) && COUNTS.every(key => count(value[key]));
}

function validMetrics(value) {
  return value == null || (objectWith(value, [...COUNTS, 'products'])
    && COUNTS.every(key => count(value[key]))
    && (value.products == null || (objectWith(value.products, PRODUCTS)
      && Object.values(value.products).every(item => item == null || validCounts(item)))));
}

export function readMicrophoneCatalog(root, stationMap, allowDemo) {
  if (!root) return { configured: false, demo: false, shifts: [] };
  const data = readCatalogFile(root);
  if (!objectWith(data, ['version', 'shifts']) || data.version !== 1
    || !Array.isArray(data.shifts) || data.shifts.length > MAX_SHIFTS) return null;
  const ids = new Set(), pdfs = new Set();
  let demo;
  for (const row of data.shifts) {
    if (!objectWith(row, ['id', 'stationId', 'date', 'status', 'pdf', 'metrics', 'demo'])
      || !opaqueId(row.id) || ids.has(row.id) || !stationMap.has(row.stationId)
      || !validDate(row.date) || !STATUSES.includes(row.status)
      || (row.demo !== undefined && typeof row.demo !== 'boolean')
      || (row.demo && !allowDemo) || (demo !== undefined && demo !== Boolean(row.demo))) return null;
    if (row.status === 'ready') {
      if (typeof row.pdf !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,119}\.pdf$/i.test(row.pdf)
        || pdfs.has(row.pdf.toLowerCase()) || !validMetrics(row.metrics)) return null;
      pdfs.add(row.pdf.toLowerCase());
    } else if (row.pdf != null || row.metrics != null) return null;
    ids.add(row.id);
    demo = Boolean(row.demo);
  }
  return { configured: true, demo: Boolean(demo), shifts: data.shifts };
}

export function openMicrophoneReport(root, shift) {
  if (shift?.status !== 'ready') return null;
  const opened = openSafeFile(root, shift.pdf, MAX_PDF_BYTES);
  if (!opened) return null;
  const header = Buffer.alloc(PDF_SIGNATURE.length);
  try {
    if (readSync(opened.fd, header, 0, header.length, 0) === header.length && header.equals(PDF_SIGNATURE)) return opened;
  } catch { /* unavailable report */ }
  opened.close();
  return null;
}

function readyMetrics(metrics) {
  if (metrics == null) return null;
  return { ...byCount(key => metrics[key] ?? null),
    products: byProduct(id => byCount(key => metrics.products?.[id]?.[key] ?? null)) };
}

export function microphoneSummary(root, catalog, stations, { from, to, region, stationId }) {
  const permitted = new Set(stations.map(station => station.id));
  const scopedShifts = catalog.shifts.filter(shift => permitted.has(shift.stationId));
  const selected = new Set(stations.filter(station => (!region || region === station.region)
    && (!stationId || stationId === station.id)).map(station => station.id));
  const selectedShifts = scopedShifts.filter(shift => selected.has(shift.stationId));
  const latestDate = selectedShifts.reduce((latest, shift) => !latest || shift.date > latest ? shift.date : latest, null);
  const shifts = selectedShifts.filter(shift => (!from || shift.date >= from) && (!to || shift.date <= to))
    .map(shift => {
      const { id, stationId, date, demo } = shift;
      let { status } = shift;
      if (status === 'ready') {
        const opened = openMicrophoneReport(root, shift);
        if (opened) opened.close();
        else status = 'missing';
      }
      return { id, stationId, date, status, demo: Boolean(demo),
        metrics: status === 'ready' ? readyMetrics(shift.metrics) : null };
    }).sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
  const statusCounts = Object.fromEntries(STATUSES.map(key => [key, 0]));
  const totals = { ...byCount(() => null), products: byProduct(() => byCount(() => null)) };
  const coverage = { ...byCount(() => 0), products: byProduct(() => byCount(() => 0)) };
  const addCounts = (values, sums, known) => {
    for (const key of COUNTS) {
      if (values?.[key] == null) continue;
      sums[key] = (sums[key] ?? 0) + values[key];
      known[key]++;
    }
  };
  for (const shift of shifts) {
    statusCounts[shift.status]++;
    if (!shift.metrics) continue;
    addCounts(shift.metrics, totals, coverage);
    for (const id of PRODUCTS) addCounts(shift.metrics.products[id], totals.products[id], coverage.products[id]);
  }
  return { configured: catalog.configured, demo: catalog.demo && scopedShifts.length > 0, latestDate,
    stations: stations.map(({ id, region, city, address }) => ({ id, region, city, address })),
    shifts, summary: { ...statusCounts, ...totals, coverage } };
}
