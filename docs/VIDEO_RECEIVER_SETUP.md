# Ограниченный приём и анализ одной камеры

Этот вариант добавляется к основному кабинету отдельным Compose-файлом. Он записывает только явно запущенный отрезок, затем отдельная команда анализирует завершённый файл. Обычный `docker compose -f compose.yaml up` не требует видео, модели, Xiaomi-секретов или supplier-классов и продолжает работать самостоятельно.

Образ не содержит `micam.*`, весов модели, авторизации или записей. Никаких загрузок/подключений к камере при старте образа нет. Реальная Linux-сессия Xiaomi, происхождение и безопасность supplier-классов, точность на ПТО и производительность сервера требуют отдельной проверки программистом. Доступ к серверу компании у исполнителя отсутствует; локальная Windows-проверка не заменяет контейнерный CI.

## Перед началом

Основная установка и bootstrap-секрет администратора готовятся по [SERVER_DEPLOYMENT.md](SERVER_DEPLOYMENT.md). Overlay всегда используется вместе с `compose.yaml`: именно основной файл определяет секрет, БД и изолированную сеть кабинета. Не подменять server-авторизацию учебной ради запуска видео.

Подтвердить одну привязку cameraId/stationId/mappingVersion/timezone. StationId должен существовать в реестре, primary — один на ПТО. Идентификаторы безопасные, до 64 ASCII букв/цифр/`_`/`-`, не DID, URL или ключ. Поля одинаковы в `collector.json`, `camera-analysis.json` и `cabinet-analysis.json`. Изменение названия Xiaomi не является подтверждением привязки. Геометрия зон и линии в примере условная: программист настраивает её под реальный ракурс до оценки счётчика.

Программист самостоятельно предоставляет допустимые `micam.*` и действующую Xiaomi-авторизацию защищённым способом вне Git. Автоматического скачивания/распространения vendor-классов нет. До проверки источника, лицензии и поведения эти классы не являются готовой production-зависимостью.

Все следующие команды — для Linux в каталоге приложения. Требуются Docker Compose с поддержкой `bind.create_host_path:false`, действующая `.env` основной установки и файл bootstrap-пароля. Добавить настройки из `deploy/video.env.example` в существующую `.env`, сохраняя основной origin/секрет. Примеры не содержат рабочих значений.

```bash
mkdir -p private/video-config private/video-vendor private/video-relay private/video-models
chmod 700 private private/video-config private/video-vendor private/video-relay private/video-models
cp deploy/video-collector.json.example private/video-config/collector.json
cp deploy/video-bridge.json.example private/video-config/bridge.json
cp deploy/video-cabinet-analysis.json.example private/video-config/cabinet-analysis.json
cp deploy/video-analysis.json.example private/video-config/camera-analysis.json
chmod 600 private/video-config/*.json
```

Внести подтверждённую привязку и приватные значения в эти файлы локальным редактором; перенести авторизацию в `private/video-config/go2rtc.yaml`. Не вставлять токен в командную строку, `.env`, историю shell, Git или логи. Положить только предоставленные class-файлы в `private/video-vendor` с сохранением структуры `micam/...`. Не монтировать домашний каталог, весь runtime или каталоги других сервисов. Контейнер работает как UID/GID 1000:1000: узкие каталоги/файлы должны быть доступны этому пользователю (например, администратор назначает владельца этих четырёх новых каталогов через `sudo chown -R 1000:1000 private/video-config private/video-vendor private/video-relay private/video-models`). Не менять владельца всего проекта.

## Сборка, модель и проверка зависимостей

```bash
docker compose -f compose.yaml -f compose.video.yaml build video-receiver video-analysis
docker compose -f compose.yaml -f compose.video.yaml config --quiet
```

Это отдельный необязательный Python/FFmpeg/JDK/ONNX-образ; основной Node-образ не устанавливает эти зависимости. Точный проверенный digest образа и версию системных пакетов сохраняют при внедрении. Значения CPU=2 и RAM=2 GiB — защитные ограничения пилота, не измеренная вместимость сети камер.

Собрать только наш `RelayLive.java` против уже предоставленных классов:

```bash
docker compose -f compose.yaml -f compose.video.yaml run --rm --no-deps -T \
  -v "$PWD/private/video-relay:/relay-out" \
  video-receiver bash deploy/build-relay.sh /opt/vendor/classes /relay-out
docker compose -f compose.yaml -f compose.video.yaml run --rm --no-deps -T \
  video-receiver python deploy/video-preflight.py \
  --bridge-config /run/private/config/bridge.json --vendor-classes /opt/vendor/classes \
  --collector-config /run/private/config/collector.json
```

Сборка использует JDK 17 и пустой sourcepath: чужие `.java` не компилируются, vendor-файлы не копируются. Только `RelayLive*.class` попадают в отдельный output. При отсутствии supplier-классов helper/preflight завершаются кодом 2 и `VENDOR_CLASSES_MISSING`; данные/параметры сторонних процессов не выводятся. Preflight проверяет Python, Java/Javac, FFmpeg/ffprobe, наличия классов и пакетов, writable runtime и доступность файла авторизации. С `--collector-config` дополнительно проверяются обязательные пути FFmpeg/ffprobe самого collector и ограниченный decode timeout. Он не читает токен, не выполняет provisioning и не подключается к камере. Успех preflight означает наличие зависимостей, не приёмку безопасности vendor или транспорта.

Модель загружается отдельной явной командой на подготовленной машине с Python-зависимостями из `video/requirements.txt` (предпочтительно отдельное виртуальное окружение):

```bash
python -m video.fetch_model --output private/video-models/yolox_nano.onnx
```

Helper использует закреплённый источник и SHA-256; не принимать другой файл без проверки. Если загрузка/хеш не прошли, анализ не готов. Не отключать проверку хеша и не добавлять веса в Git. При работе модели кадры не уходят внешнему API. Сервис `video-analysis` не имеет сети; веса монтируются read-only. Подготовка модели не разрешает автоматически подключать камеры.

## Первичная подготовка томов

Два новых именованных тома содержат только записи и результаты пилота. **До первого запуска кабинета с overlay** создать их через образ видео: начальные владельцы каталогов в нём 1000:1000. Если первым создать том через основной Node-образ, владельцем может стать root, и nonroot-процессу потребуется отдельное исправление владельца именно новых томов администратором.

```bash
docker compose -f compose.yaml -f compose.video.yaml run --rm --no-deps -T \
  video-receiver python -c 'from pathlib import Path; p=Path("/video/recordings"); t=p/".permission-check"; t.write_text("ok"); t.unlink()'
docker compose -f compose.yaml -f compose.video.yaml run --rm --no-deps -T \
  video-analysis python -c 'from pathlib import Path; p=Path("/video/results"); t=p/".permission-check"; t.write_text("ok"); t.unlink()'
```

Эти две команды проверяют только запись в своих томах и не включают камеру/модель. Внутренние volumes по умолчанию не ограничивают общий объём: лимит 256 MiB действует на один capture. До повторных запусков нужен согласованный срок хранения, свободное место и отдельная квота файловой системы; бесконечной автоматической записи/очистки в пилоте нет. Не применять `down --volumes` к рабочей установке: удалятся и её данные.

## Один отрезок и один анализ

В двух config-файлах bridge/collector `maxSeconds` равен 300. Collector отклоняет конфиг, если длительность bridge превышает его потолок. Один запуск получает до 300 секунд материала; первый байт ожидается до 110 секунд, пауза после получения — до 20 секунд, общий приём — до 420 секунд. ffprobe получает отдельно до 10 секунд. Затем обязательный FFmpeg полностью декодирует видеопоток до конца, с `-xerror -err_detect explode`, без создания другого видео и без сети. Для этого в collector config обязателен абсолютный `ffmpeg`, а `decodeTimeoutSeconds` по умолчанию 120 (целое 1–600 секунд). STOP/сигнал прерывает и этот этап, процессы очищаются. Источник, ffprobe и decode не передают свои сообщения в логи. Остановка/очистка также ограничены. Потолок файла 256 MiB, резерв свободного места 512 MiB плюс ожидаемый максимальный файл до старта. Пропускается один видеопоток до 3840×2160, от 0,5 до 120 fps — тот же бюджет, что у анализатора. Слишком тяжёлый для отведённого времени файл отклоняется. Не увеличивать эти значения для всей смены: bridge ограничен 600 секундами, фрагмент не является итогом дня.

После preflight явный запуск выбранной камеры:

```bash
docker compose -f compose.yaml -f compose.video.yaml run --rm --no-deps -T \
  video-receiver python -m video.collector --config /run/private/config/collector.json
```

При успехе stdout содержит только `status` и непрозрачный `runId`. Записать этот runId и подставить его вместо `RUN_ID` в следующей команде:

```bash
docker compose -f compose.yaml -f compose.video.yaml run --rm --no-deps -T \
  video-analysis python -m video.analysis \
  --config /run/private/config/camera-analysis.json \
  --capture /video/recordings/RUN_ID/capture.json \
  --archive-root /video/recordings --results-dir /video/results \
  --model /video/models/yolox_nano.onnx
docker compose -f compose.yaml -f compose.video.yaml up --detach --no-build --wait camera-pilot
```

Receiver использует отдельную сеть только для исходящих подключений, не публикует порты и не соединён с сетью кабинета. Offline-анализ без сети. Кабинет получает results/archive read-only, приватную конфигурацию по `PILOT_ANALYSIS_CONFIG` и прежнюю изолированную сеть. Пользователи/SQLite/права не передаются видео-процессам. `restart:no` и profile `video` не создают фоновой записи; без явной команды контейнеры показывают `--help`. Не запускать `--profile video up` как службу наблюдения: расписание и непрерывный приём здесь не реализованы.

Для остановки послать SIGTERM контейнеру (`docker stop` выбранного одноразового receiver-контейнера) либо явную строку `STOP\n` в stdin. EOF stdin сам по себе не останавливает CLI: так работает `run -T`. Ctrl+C также обрабатывается. Collector просит bridge STOP, затем завершает всю POSIX-группу и ожидает процессы. На Windows предусмотрен bounded `taskkill /T /F` как best effort; отсоединённые процессы требуют Windows Job Object у отдельного supervisor. Linux — целевой путь этой поставки.

## Файлы и проверяемый результат

Collector пишет в новый случайный каталог `<archiveRoot>/<runId>/`: сначала `video.mp4.part`, затем после нормального завершения источника, успешного ffprobe **и полного успешного декодирования FFmpeg** — `video.mp4`. Проверяются видеопоток/размеры/fps и конечная положительная длительность в пределах лимита. Одних читаемых MP4-заголовков недостаточно: усечённый последний NAL может проходить ffprobe и всё равно быть повреждённым. SHA-256 считается по принятым байтам. `capture.json` регистрируется последним атомарным rename. При timeout/stall/STOP/ненулевом exit/ошибке ffprobe или decode/лимите незавершённые файлы удаляются, успешного манифеста нет. Аварийное SIGKILL/отключение питания может оставить незарегистрированный файл: анализатор должен принимать только завершённый capture, а не искать любое `.mp4`.

Capture v1: `schemaVersion`, `runId`, `cameraId`, `stationId`, `mappingVersion`, IANA `timezone`, `status:complete`, `coverage.status:partial`, `receivingStartedAt`, `receivingEndedAt`, `timingSource:bridge-genpts-20fps`, а также `recording` с `id`, относительным `file`, `sha256`, `startedAt`, `durationSeconds`, `timing:estimated`. `startedAt` — время первого полученного байта, не подтверждённые часы камеры. Bridge создаёт 20 fps с `genpts`: точное открытие/закрытие по этим часам не подтверждено. Отрезок не доказывает полноту дня, смены или всех событий.

Успешный нейросетевой запуск должен атомарно создать `<runId>.json` в resultsDir. После входа в кабинет проверить запись/события доступной камеры, пометку неполных предварительных данных и отказ ограниченному пользователю в доступе к другой камере. Пустой результат — отсутствие обнаруженных событий в обработанном отрезке, не ноль машин за день. Проверьте остановку: у завершённого receiver-контейнера не остаются bridge/Java/FFmpeg-процессы или временные provisioning-файлы.

Повторяемые проверки без камеры:

```bash
python -m unittest discover -s tests -p 'test_video_collector.py'
python -m unittest discover -s tests -p 'test_video_analysis.py'
```

Collector-suite генерирует собственные bytes, ffprobe/decode-stub и процессы в `private/video-receiver-validation/`; существующие записи/ключи не читает. При доступных FFmpeg/ffprobe отдельный интеграционный тест создаёт 3-секундный H.264/fMP4, обрезает последние 128 байт, подтверждает успешный header probe и отказ collector; целый файл принимается. Без FFmpeg этот интеграционный тест пропускается. POSIX-тест проверяет SIGTERM и потомка, чей родитель уже завершился; на Windows он пропускается. Полноценный Linux Docker smoke и тест реальной Xiaomi-сессии — разные проверки. Container/inference должен быть отдельно подтверждён CI/программистом; unit-стаб не является доказательством декодируемости реального видео.
