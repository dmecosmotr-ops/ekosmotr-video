/**
 * Conservative address suggestions from safe camera metadata. A match is not
 * proof of installation, permission, connectivity or successful video analysis.
 * No I/O, cloud requests, identity generation or input mutation occurs here.
 */
const NUMBER = /^\d+[a-zа-я]?$/u;
const WORD = /^[a-zа-я]+$/u;
const NUMBER_KINDS = new Map([
  ['д', 'house'], ['дом', 'house'], ['вл', 'house'], ['владение', 'house'],
  ['к', 'corpus'], ['корп', 'corpus'], ['корпус', 'corpus'],
  ['стр', 'building'], ['строение', 'building'],
]);
const NOISE = new Set([
  'ул', 'улица', 'проспект', 'просп', 'пр', 'пркт', 'проезд', 'пер', 'переулок',
  'ш', 'шоссе', 'квартал', 'дорога', 'тракт', 'на', 'д', 'дом', 'корп', 'корпус',
  'к', 'стр', 'строение', 'вл', 'владение', 'зд', 'здание', 'лит', 'литера',
  'г', 'город', 'п', 'пос', 'поселок', 'рабочий', 'пгт', 'з', 'у', 'зу',
  'камера', 'видеокамера', 'xiaomi', 'smart', 'camera', 'пто', 'бокс', 'въезд',
  'выезд', 'вход', 'выход', 'ворота', 'дверь', 'линия', 'диагностическая',
  'клиентская', 'зона', 'эксперт', 'обзор',
]);
const STREET_MARKER = /(^|[^\p{L}])(ул|улица|проспект|просп|проезд|пер|переулок|шоссе|квартал|дорога)(?=$|[^\p{L}])/u;

function tokens(value) {
  if (typeof value !== 'string') return [];
  let text = value.normalize('NFKC').toLowerCase().replace(/ё/gu, 'е');
  // A role suffix attached to a number is not a house letter: 37бокс, 226въезд.
  text = text.replace(/(\d+[a-zа-я]?)\s*(?:бокс|въезд|выезд|вход|выход|камера|camera)(?=$|[^\p{L}])/gu, '$1 ');
  text = text.replace(/(\d+[a-zа-я]?)\s*(?:корпус|корп\.?|к)\s*(?=\d)/gu, '$1 корпус ');
  text = text.replace(/(\d+[a-zа-я]?)\s*(?:строение|стр\.?)\s*(?=\d)/gu, '$1 строение ');
  text = text.replace(/(\d+)\s+([a-zа-я])(?=$|[^\p{L}\p{N}])/gu, '$1$2');
  return (text.match(/\d+[a-zа-я]?|[a-zа-я]+|\//gu) || []).map(token => {
    if (NUMBER.test(token)) return token.replace(/a$/u, 'а');
    if (token === 'к' || token === 'корп') return 'корпус';
    if (token === 'стр') return 'строение';
    return token;
  });
}

function fullKey(parts) {
  return parts.filter(token => !NOISE.has(token) || ['корпус', 'строение'].includes(token)).join(' ');
}

function contentWords(parts) {
  return parts.filter(token => WORD.test(token) && token.length >= 3 && !NOISE.has(token));
}

function describeStation(station) {
  const address = typeof station.address === 'string' ? station.address : station.name;
  const parts = tokens(address);
  const places = new Set([...tokens(station.city), ...tokens(station.region)]);
  const components = typeof address === 'string' ? address.split(',') : [];
  const explicitStreet = components.find(component => STREET_MARKER.test(component.toLowerCase().replace(/ё/gu, 'е')));
  // The street component, not a city or a later landmark, supplies the anchor.
  const street = explicitStreet ?? (components.length > 1 ? components[1] : address);
  const streetWords = new Set(contentWords(tokens(street)).filter(word => word.length >= 5 && !places.has(word)));
  return { id: station.id, parts, key: fullKey(parts), words: new Set(contentWords(parts)), streetWords };
}

function numberParts(parts) {
  const found = [];
  let kind = null;
  for (const token of parts) {
    if (token === '/') kind = 'fraction';
    else if (NUMBER_KINDS.has(token)) kind = NUMBER_KINDS.get(token);
    else if (NUMBER.test(token)) {
      found.push({ value: token, kind: kind ?? (found.length === 0 ? 'house' : null) });
      kind = null;
    }
  }
  return found;
}

function numberPrefixMatches(query, source) {
  return query.length <= source.length && query.every((part, index) =>
    part.value === source[index].value && (!part.kind || part.kind === source[index].kind));
}

function numbersAgree(query, station, anchors) {
  const lastAnchor = [...query].reverse().find(token => anchors.has(token));
  const queryIndex = query.lastIndexOf(lastAnchor);
  const stationIndex = station.parts.lastIndexOf(lastAnchor);
  const beforeQuery = numberParts(query.slice(0, queryIndex));
  const beforeStation = numberParts(station.parts.slice(0, stationIndex));
  return numberPrefixMatches(beforeQuery, beforeStation)
    && numberPrefixMatches(numberParts(query.slice(queryIndex + 1)), numberParts(station.parts.slice(stationIndex + 1)));
}

function output(camera, candidates, reason) {
  const ids = [...new Set(candidates.map(station => station.id))].sort();
  return {
    ...camera,
    stationId: ids.length === 1 ? ids[0] : null,
    mappingStatus: ids.length === 1 ? 'matched' : ids.length > 1 ? 'ambiguous' : 'needs_mapping',
    mappingReason: reason,
    candidateStationIds: ids,
  };
}

function matchPrepared(camera, stationDescriptions) {
  if (!camera || !['string', 'number'].includes(typeof camera.id) || String(camera.id).trim() === '') {
    return output(camera, [], 'У камеры нет постоянного идентификатора. Нужно сопоставление вручную.');
  }
  const query = tokens(camera.name);
  const key = fullKey(query);
  if (!key) return output(camera, [], 'В названии камеры нет адреса. Нужно сопоставление вручную.');
  const exact = stationDescriptions.filter(station => station.key && station.key === key);
  if (exact.length) return output(camera, exact, exact.length === 1
    ? 'Полный адрес совпадает с единственной станцией.'
    : 'Полный адрес встречается у нескольких станций. Нужна проверка.');

  const words = contentWords(query);
  const addressCandidates = stationDescriptions.filter(station => {
    const anchors = words.filter(word => word.length >= 5 && station.streetWords.has(word));
    return anchors.length > 0 && words.every(word => station.words.has(word));
  });
  const candidates = addressCandidates.filter(station => numbersAgree(query, station,
    new Set(words.filter(word => station.streetWords.has(word)))));
  if (candidates.length > 1) {
    return output(camera, candidates, 'Название подходит к нескольким станциям. Нужны город или точный номер.');
  }
  if (candidates.length === 1) {
    return output(camera, candidates, query.some(token => NUMBER.test(token))
      ? 'Улица и указанные номера совпадают с единственной станцией.'
      : 'Название улицы совпадает только с одной станцией в реестре.');
  }
  return output(camera, [], addressCandidates.length
    ? 'Номер в названии камеры не совпадает с подходящими адресами. Нужна проверка.'
    : 'По названию нельзя однозначно определить адрес станции. Нужно сопоставление вручную.');
}

/** The safe input id is copied verbatim; list position and name never become an id. */
export function matchCamera(camera, stations) {
  const descriptions = stations.filter(station => station && typeof station.id === 'string' && station.id)
    .map(describeStation);
  return matchPrepared(camera, descriptions);
}

export function matchCameras(cameras, stations) {
  const descriptions = stations.filter(station => station && typeof station.id === 'string' && station.id)
    .map(describeStation);
  return cameras.map(camera => matchPrepared(camera, descriptions));
}
