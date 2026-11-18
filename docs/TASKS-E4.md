# E4 — Files slice (E4-B / E4-F)

> **Цель:** managed-файлы end-to-end: preflight, лимиты, chunk/resume, S3/MinIO, квоты, сканирование, вложение в сообщение и скачивание.  
> **Контракт:** [`contracts/openapi.yaml`](<../contracts/openapi.yaml>) — `uploads/*`, `attachments/*`, `workspace limits`, расширенные `Message`/`MessageCreate`.  
> **Анализ:** [`docs/SYSTEM-ANALYSIS.md`](<SYSTEM-ANALYSIS.md>) §6.7, §7, §8.4, §11.2–11.3, §12, §15.

## 0. Правила

| Зона | Владелец | Можно менять | Нельзя менять |
|---|---|---|---|
| `backend/**`, `infra/**` | E4-B | всё внутри | `frontend/**`, `docs/**`, `contracts/**` |
| `frontend/**` | E4-F | всё внутри | `backend/**`, `infra/**`, `docs/**`, `contracts/**` |

- Контракт уже расширен PM; менять нельзя; расхождения — `[BLOCKED]`.
- E4 — **managed only**. E2EE-файлы (клиентское шифрование/ключи) — отдельный срез после E2EE; не имитировать.
- Single-node backend; S3/MinIO; AV — через порт, dev-адаптер допустим, но статусная модель и fail-closed обязательны.
- `8080` не трогать; порты: backend 8081, frontend 5173, MinIO 9002/9003, Keycloak 8180, PostgreSQL 5432.

## 1. E4-B — backend: files pipeline

**Владелец:** backend-сессия  
**Оценка:** 3–4 сессии  
**Статус:** **DONE with caveat** — 230 тестов, live 20 МиБ через s3mock (MinIO image недоступен), E4-F real UI 1/1

### Scope

1. **DDD-контекст `ru.krug.backend.file`**
   - domain: `Upload`/`Attachment` aggregates, `UploadStatus`, `QuotaReservation`, `FileSize`, `Sha256`, исключения.
   - application: preflight/init/part/complete/abort/download use cases, ports `ObjectStoragePort`, `MalwareScanPort`, `WorkspaceQuotaPort`, `ClockPort`.
   - infrastructure: JPA adapters, S3/MinIO adapter, scan adapter, quota adapter, schedulers.
   - api: controllers, DTO, mappers.
   - ArchUnit обновить; DTO только api.dto; JPA только infrastructure.persistence.
2. **DB (V9)**
   - `workspace_limits` (tariff, max_file_bytes, storage_bytes, max_attachments, guest_file_bytes, retention), `workspace_usage` (used/reserved), `uploads`, `upload_parts`, `attachments`, `quota_reservations`.
   - RLS по `workspace_id`; индексы `(workspace_id,status)`, `(chat_id,created_at)`, `upload_parts PK(upload_id,part_no)`.
   - Backfill limits для существующих воркспейсов (Team/2 ГБ/1 ТБ или безопасный дефолт).
3. **S3/MinIO**
   - compose-сервис MinIO на 9002/9003, bucket `krug`, healthcheck; env `S3_*`.
   - `ObjectStoragePort`: multipart create/part/complete/abort, presigned GET TTL 5 мин.
   - В MVP части идут через API (не presigned upload); v1 — presigned.
4. **API**
   - `GET /workspaces/{id}/limits` — tariff/limits/usage.
   - `POST /uploads/preflight` — лимит файла, число, квота, MIME/type policy; до байтов; `ALLOW/DENY` по каждому.
   - `POST /uploads` — init, reservation `ACTIVE`, `part_size=8MiB`, `total_parts`, TTL 24 ч.
   - `PUT /uploads/{id}/parts/{n}` — binary; `Content-SHA256`; идемпотентно; 409 при другом хеше; 422 при несовпадении.
   - `GET /uploads/{id}` — статус/received/missing.
   - `POST /uploads/{id}/complete` — проверка частей/размера/финального sha256; S3 complete; managed → `SCANNING`; E2EE нет.
   - `POST /uploads/{id}/abort` — release reservation, S3 abort.
   - `GET /attachments/{id}/download-url` — только `READY/BOUND`/`CLEAN`; 423 при карантине.
5. **Квоты/скан**
   - reservation: `used + reserved + new ≤ limit` в одной транзакции; commit на complete; release на abort/expiry; GC ≤24 ч; reconcile.
   - `MalwareScanPort`: dev `NoopScanner` → `CLEAN`; ClamAV adapter optional; статусы `PENDING/CLEAN/INFECTED/FAILED/SKIPPED`; fail-closed.
   - `SCANNING → READY/QUARANTINED`; download blocked until CLEAN.
6. **Сообщения с вложениями**
   - `MessageCreate.attachment_ids` (≤10): проверка владельца, чата, `READY/CLEAN`, не привязан; bind; quota commit; `Message.attachments` в response.
   - Realtime `message.created` payload включает attachments (OpenAPI Message).
   - Ошибки: 409 `ATTACHMENT_NOT_READY`, 422 `TOO_MANY_FILES`, 423 `ATTACHMENT_QUARANTINED`.
7. **Тесты**
   - preflight oversized/quota/too many/type; chunk idempotency/hash mismatch; resume; complete; abort release; scan infected; bind; download 423; RLS cross-tenant; quota race.
   - Full suite (181 baseline) + ArchUnit 10/10 не ломать.
   - Live: MinIO, upload 5–20 МБ чанками, complete, send, download; quota before/after.

### Вне scope

E2EE-файлы/ключи, presigned upload, DLP, retention UI, публичные ссылки, CDN, многопартовый >2 ГБ (desktop v1), стикеры.

## 2. E4-F — frontend: файлы в чате

**Владелец:** frontend-сессия  
**Оценка:** 2–3 сессии  
**Статус:** **DONE** — 143 Vitest, contract 18/26, real UI upload/send/download 1/1

### Scope

1. **Выбор файла**
   - Кнопка «Скрепка», drag&drop, несколько файлов ≤10.
   - Preflight до загрузки; показать лимит/квоту/причину отказа по каждому файлу.
2. **Загрузка**
   - init → части 8 МБ с прогрессом; pause/resume/cancel; retry с теми же `upload_id/part_no`.
   - 413/409/415/422/423/429 — понятные сообщения; текст не теряется.
   - При обрыве: `GET /uploads/{id}` → missing parts → докачка.
3. **Отправка**
   - Сообщение с `attachment_ids` (text optional); optimistic; после `201` заменить; attachments render.
   - Ошибки `ATTACHMENT_NOT_READY`/`QUARANTINED`/`TOO_MANY_FILES`.
4. **Отображение/скачивание**
   - Карточка файла: имя, размер, тип, scan status; download через presigned URL; изображения — превью; PDF/видео — ссылка.
   - 423 — «файл на проверке/карантине».
5. **Лимиты**
   - `GET /workspaces/{id}/limits` + usage bar; 80/95/100% предупреждения; guest limit.
6. **Тесты**
   - MSW preflight/upload/parts/complete/message/download; RTL progress/errors/resume; Playwright mock upload + send; axe.
   - Contract types regen (`npm run api:types`); `npm run check` зелёный.

### Вне scope

E2EE-файлы, AV UI, DLP, публичные ссылки, CDN, 10 ГБ.

### E4: результат

| Проверка | Результат |
|---|---|
| Backend E4-B | 230 тестов, ArchUnit 10/10 |
| Frontend E4-F | 143 теста, contract 18/26, build/lint/security |
| Real backend 20 МиБ | preflight ALLOW, 3 parts 8+8+4, complete SCANNING, download SHA match, message with attachments, quota 20 МиБ, abort 5 МиБ release |
| Real UI E2E | upload → READY → send → attachment card → download, **1 passed** (PM-added `files.real.spec.ts`) |
| E3 regression | real WS 1/1 после E4 |
| QUARANTINED | контракт + backend + frontend выровнены |
| RLS/quota | cross-tenant tests, quota race, bind без повторного charge |

Caveat: Docker Hub не отдал `minio/minio`; live-проверка выполнена на `adobe/s3mock` (тот же S3 multipart/presign контракт). Compose MinIO валиден, но образ нужно запинить/получить в среде деплоя.

## 3. Acceptance (E4-AC)

| ID | Сценарий | Ожидание |
|---|---|---|
| E4-AC-01 | Файл больше лимита | `413 FILE_TOO_LARGE` до загрузки |
| E4-AC-02 | Квота 100% | `409 QUOTA_EXCEEDED`; 80% — warning |
| E4-AC-03 | 11 файлов | `422 TOO_MANY_FILES` |
| E4-AC-04 | Обрыв на 60% | resume с missing parts; один объект |
| E4-AC-05 | Неверный hash части | `422 CHUNK_HASH_MISMATCH`; повтор |
| E4-AC-06 | Complete | `SCANNING → READY`; отправка сообщения |
| E4-AC-07 | Заражённый файл | `QUARANTINED`; download 423 |
| E4-AC-08 | Скачивание | presigned URL TTL 5 мин |
| E4-AC-09 | Чужой чат/воркспейс | 403/404, RLS |
| E4-AC-10 | Лимиты | usage до/после commit; release при abort |

## 4. Решения

| ID | Решение | Причина |
|---|---|---|
| E4-D-01 | Managed only | E2EE-файлы требуют ключей; отдельный срез |
| E4-D-02 | Chunk 8 МБ через API | Проще authz/quota; presigned upload — v1 |
| E4-D-03 | Quota reservation | Не гонять лимит; commit/release |
| E4-D-04 | AV port + dev NoopScanner | Не тащить ClamAV в каждый dev; fail-closed статус |
| E4-D-05 | Max 2 ГБ web | Ограничение браузера/памяти; 10 ГБ — desktop v1 |

## 5. Известный долг

- Нет E2EE-файлов.
- Нет presigned upload/CDN.
- Нет DLP/retention UI.
- AV dev-адаптер; production ClamAV — отдельная задача.
- 10 ГБ/desktop — v1.
