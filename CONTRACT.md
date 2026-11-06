# Camera pilot API contract

## Optional recorded video analysis — 05.11.2026

`PILOT_ANALYSIS_CONFIG` / `createApp({analysisConfigFile})` enables explicitly confirmed camera/station/mappingVersion/timezone bindings and read-only private result/archive roots. The strict v1 manifest is defined in `docs/VIDEO_ANALYSIS_PLAN_2026_11_05.md`. All observations remain `source:analysis`, `coverage:partial`, `needsReview:true`; estimated camera timing is explicit. Positive counters come only from the visible designated primary camera; an empty fragment is not a zero day. `openedAt/closedAt` stay null; gate candidates are separate review events. Stations expose separately scoped `demoMetrics` so a real result cannot replace the example on its date.

Events add `occurredAtUtc`, local `date/time`, `runId`, `pipelineVersion`, `timing`, and `evidence:{recordingId,offsetSeconds,mediaUrl}`. Exact playback: authenticated/scoped `GET /api/cameras/:id/recordings/:recordingId?offsetSeconds=<finite>` returns `{record}` with the exact original offset and at most30seconds to the file end, including midnight. No fallback to another recording. Protected media is `GET /api/cameras/:id/recordings/:recordingId/media`; bounded single Range, current session/permissions and registered file checks apply. Archive playback/search preserve the prior shapes and include partial/timing metadata. No private path or provider key is returned. Shutdown cancels active archive streams before closing SQLite.

Collector and CPU analysis run as explicit one-shot commands in the separate optional video image. Their processes never access the user DB; the default cabinet remains independent. Setup, limits and remaining company-server acceptance: `docs/VIDEO_RECEIVER_SETUP.md` and `docs/VIDEO_PIPELINE_RESULT_2026_11_05.md`. No automatic70-camera collection or deployment is added.

Same origin `/api`, JSON. Error: `{error: "Короткое понятное сообщение", code: "ENUM"}`. Success bodies directly objects. All collection endpoints return objects with named arrays. Dates `YYYY-MM-DD`, times local station as strings or null. Default demo date `2026-10-30`.

## Display update — 05.11.2026

`GET /api/cameras` additionally returns `archiveAvailable:boolean`. It is true only for the registered probe camera when its actual nonempty media file exists, consistent with the authenticated playback endpoint. This is availability in this pilot, not a claim about Xiaomi/SD storage. `liveAvailable` continues to mean configured viewing capability; the connection is checked only on manual start.

The UI starts in `real` mode with the browser's local day, excludes demo cameras/events/metrics and recomputes camera counts from the visible list. The separate `demo` mode selects the explicit example date and displays only example cameras/events, while retaining all permitted station addresses for search. This is presentation filtering, not authorization: server scope applies to every input and media endpoint. Management always receives the entire server-authorized station/camera list, regardless of the selected display mode. No real AI coverage or full camera archive has been added by this UX change.

## Auth/user

- `GET /api/session` -> `{user: User|null, csrfToken: string|null, demoDate:"2026-10-30", mode:"pilot"}`.
- `POST /api/login` `{email,password}` -> same authenticated session shape. HttpOnly SameSite=Strict cookie. No password echoed.
- `POST /api/logout` -> `{ok:true}`; invalidate cookie/session.
- For mutations except login: header `X-CSRF-Token` from session. Validate origin when present. Login origin validation too.
- `User={id,name,email,role:"admin"|"director"|"regional",active,stationIds:string[],cameraIds:string[]}`.
- `GET /api/users` -> `{users:User[]}` scoped list (admin all, director own created regionals). Regional denied.
- `POST /api/users` `{name,email,password,role,stationIds,cameraIds}` -> `{user:User}`. Admin can all; director only regional and within own effective scope.
- `PATCH /api/users/:id` same mutable fields, password optional -> `{user:User}`; no privilege escalation or last-admin deactivation.

## Station/camera/events

- `GET /api/stations?date=...` -> `{stations:Station[], demoDate, demo:true|false}`.
- `Station={id,region,city,address,manager, cameraCount, metrics:Metrics}`.
- `Metrics={source:"demo"|"none",openedAt:string|null,closedAt:string|null,firstSeenAt:string|null,entries:number|null,exits:number|null,completedVisits:number|null,coverage:string|null,note:string|null}`. Null is no data, never zero. Metrics only from visible cameras.
- `GET /api/cameras?stationId=...&date=...` -> `{cameras:Camera[]}`.
- `Camera={id,stationId:string|null,name,model,view:"gate_line"|"client_area"|"unknown",status:"demo"|"unconnected"|"recorded_probe",liveAvailable:boolean,archiveAvailable:boolean,metrics:Metrics,mediaUrl:string|null}`. liveAvailable means a configured manual diagnostic live request, not measured current availability or AI readiness.
- `GET /api/events?date=...&stationId=...&cameraId=...` -> `{events:Event[]}` filtered by grants.
- `Event={id,stationId,cameraId,time,type:"opened"|"closed"|"first_seen"|"vehicle_entry"|"vehicle_exit"|"gap",visitId:string|null,label,description,source:"demo",needsReview:boolean}`. Paired demo entry/exit share visitId, not a plate/unique-person identity. Don't expose hidden camera events in station totals.
- `GET /api/cameras/:id/media` authorized only. Known local original probe file from env/config, never URL tokens or camera credentials. HEAD/range support desirable, path traversal rejected.
- `GET /api/audit` -> `{events: Audit[]}` admin all, director own actions/grants, regional denied. `Audit={id,at,actor,action,target,details}` no passwords/tokens.
- `GET /api/health` -> `{ok:true,mode:"pilot"}`.

## Visits and playback (03.11 update)

- `GET /api/visits?date=...&stationId=...&cameraId=...` -> `{visits:Visit[]}`. Same scope as events; pairing only within visible camera and day.
- `Visit={id,stationId,cameraId,enteredAt:string|null,exitedAt:string|null,durationMinutes:number|null,status:"paired"|"entry_only"|"exit_only",source:"demo",needsReview:boolean}`.
- `GET /api/cameras/:id/playback` -> `{cameraId,live:{status:"available"|"not_connected",url:string|null,message},archive:{status:"available"|"not_connected",days:string[],sampleRange:{date,from,to}|null,timeBasis:"camera_local_unverified"|"station_local",message}}`. Live url is an authenticated relative start endpoint, never a Xiaomi source or recorded file; actual stream URL comes from POST below.
- `GET /api/archive?cameraId=...&date=YYYY-MM-DD&from=HH:mm[:ss]&to=HH:mm[:ss]` -> `{cameraId,date,from,to,status:"available"|"empty"|"not_connected",timeBasis,records:ArchiveRecord[],message}`. Validate date/time, from<to, single day; missing intervals reject 400. Unauthorized camera returns same denial as media.
- `ArchiveRecord={id,cameraId,startAt,endAt,source:"recorded_probe",mediaUrl,startOffsetSeconds,endOffsetSeconds,durationSeconds}`. startAt/endAt are local ISO strings WITHOUT claimed timezone; offset interval clamped to actual file. Only real probe-c300 file registered: 2026-10-30T12:21:28 to 12:21:38.350, duration10.35. Arbitrary paths/remote URLs not accepted. Existing /api/cameras/:id/media remains the authorized file endpoint.
- One real camera may have a manual live adapter configured by the later live update below. UI must never loop recorded_probe as online. Gate-line demo cameras have no archived video; return archive not_connected, not false 'no recordings on camera'.
- Optional startup `PILOT_CAMERA_INVENTORY` safe metadata JSON (array id/name/model), matched through camera-matching helper. No credentials or raw provider IDs. Imported cameras status=unconnected, view=unknown, metrics=none; source/mapping label on UI. Imported names alone do not establish that their view covers gates.

## Seed/data

`data/stations.json` expected `{stations:[{id,region,city,address,manager,source?}], source?:...}` OR plain array; backend accept both. Stable IDs from address hash if no source code. 5 demo cameras attached to first appropriate existing station IDs with explicit source=demo, never imply true installed cameras or actual location of probe. One `probe-c300` camera with stationId=null and view=client_area, admin only, media from `PILOT_PROBE_MEDIA` path. No network/camera/Xiaomi calls.

Initial local accounts for UI: `admin@ekosmotr.local` / `Pilot-Admin-2026!`; `director@ekosmotr.local` / `Pilot-Director-2026!`; `regional@ekosmotr.local` / `Pilot-Region-2026!`. These are disposable local fixture credentials, not real people or Xiaomi credentials. Director initially gets all 5 demo-camera station IDs plus other source stations up to 10; regional gets the first 2 demo-camera station IDs. This is a local fixture, not a statement of real personnel assignments. Roles stored server-side. Database configurable `PILOT_DB`, default app/private/pilot.sqlite. Export `createApp({dbPath,stationFile,mediaFile?})` HTTP request handler with `.close()` for tests; `backend/server.mjs` binds loopback3210 and serves built frontend dist with SPA fallback. Sensitive responses `Cache-Control:no-store`; enforce payload limit and reject traversal.

## Manual diagnostic live (03.11 later update)

With shared Xiaomi inventory enabled, `PILOT_CAMERA_INVENTORY` also accepts a version 1 envelope `{version:1,cameras:[{id,name,model,mapping,stationId?}]}`. `mapping:'confirm'` requires a trusted exact `stationId` present in the catalog to grant station scope. Unbound cameras and address suggestions stay admin-only. `mapping:'legacy'` preserves the prior matching rule for previously loaded entries. `PILOT_LIVE_CONFIG` also accepts `{cameras:[<legacy route object>, ...]}` with up to 150 unique configured IDs. The single live slot and existing authorization continue to apply across the entire manifest.

`PILOT_XIAOMI_SYNC_DIR` enables an optional private auto-sync directory. A version 1 `current.json` points to a completed `gen-<32 lowercase hex>` directory with a catalog and matching live manifest. The cabinet adopts both together, preserves its last valid set on a malformed update, and processes removals after a successful complete refresh. Dynamic cameras require `mapping:'confirm'`. The session response adds `xiaomiSyncEnabled:true` in this mode so open browser tabs can refresh their camera list. This is catalog synchronization. Video still starts by request.

- `createApp({...,liveConfigFile?})`, env `PILOT_LIVE_CONFIG`: trusted local JSON `{cameraId,command,args,cwd,maxDurationSeconds,startupTimeoutMs,stallTimeoutMs}`. No HTTP caller can select a command, DID, URL, path or quality. Only configured camera advertises liveAvailable. Private bridge config holds the selected stable DID and dependency paths; account session remains in private go2rtc config.
- `POST /api/cameras/:id/live` requires login, canCamera, CSRF and valid Origin. Returns201 `{sessionId,streamUrl,stopUrl,expiresAt,maxDurationSeconds}`; one ticket/stream globally, 409 if busy, 503 if unconfigured. Ticket expires unused after20s and is bound to camera/user/exact login session. Opaque URLs contain only the short-lived application ticket, never provider secrets.
- `GET /api/cameras/:id/live/:sessionId/stream` returns `video/mp4` fragmented H.264, no-store/no ranges, from a fresh live subprocess. Single use; current permission checked before start and each second during streaming. Unknown/foreign tickets share403. Max600s from ticket creation, first-byte110s, stall15s. Logout/revocation/disconnect stops the process. Browser uses a single fetch+MSE stream to avoid native Range reconnects to the single-use ticket.
- `DELETE /api/cameras/:id/live/:sessionId` requires same owner/login/camera access and CSRF; returns `{ok:true}` after bridge cleanup, bounded6s. Node sends STOP, permits5s bridge cleanup; graceful application shutdown awaits actual subprocess exit, bounded6s.
- Python bridge obtains fresh provisioning by fixed DID, invokes diagnostic CS2 Java transport and FFmpeg, emits only video bytes. STOP/EOF cleans encoder first, then camera transport; fresh private provisioning is temporary. No archive registration or AI extraction is implied.
- Audit start is «Запрошен онлайн-просмотр»; stop records only a fixed reason enum, no commands, remote URLs, stderr or ticket values. Current deployment is loopback-only, one manual viewer, no automatic 24/7 service.
