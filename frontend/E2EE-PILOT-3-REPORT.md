# E2EE-PILOT-3 — negative key-change/TOFU live (#31)

> **Зона:** только `frontend/**` (`e2e/`, `src/e2ee/app/chatBridge.ts`,
> `src/store/chatStore.ts`, их тесты, README, этот отчёт). Не изменялись
> `backend/**`, `contracts/**`, `docs/**`, `design/**`, `src/api/schema.d.ts`,
> base-флаги, compose-файлы и wire-формат. Crypto/KAT/vectors не менялись.
>
> **Вход:** `docs/E2EE-REVIEW-13.md` (условие 4, P1-02/P2-07),
> `docs/E2EE-SPEC.md` §7 (TOFU/key change/safety number),
> `frontend/src/e2ee/device/pins.ts`, `frontend/src/e2ee/app/chatBridge.ts`,
> `frontend/src/store/chatStore.ts`, `frontend/src/components/SafetyNumberDialog.tsx`,
> `frontend/e2e/e2ee.real.spec.ts`, `frontend/e2e/e2ee-real-fixture.ts`,
> `frontend/E7-F7B-REPORT.md`, `frontend/E2EE-PILOT-1-REPORT.md`.

## 1. Итог

Условие 4 REVIEW-13 в части **negative key-change/TOFU live + verified reset**
закрыто live-сценарием на реальном overlay-стеке:

- тот же `device_id` получает новые identity-ключи, валидную binding-подпись,
  signed prekey и one-time prekeys (материал создан **реальной keyed-регистрацией**
  второго браузерного контекста);
- peer (A) видит `KEY_CHANGE_DETECTED`, красный баннер «Ключ безопасности
  изменился», safety number меняется, отправка заблокирована (0 `POST /messages`);
- OPK не расходуется, старая ratchet-сессия не удаляется и не перезаписывается,
  уже расшифрованная история остаётся видимой, `verified` на сервере сброшен;
- после явного «Принять новый ключ» требуется **реальная повторная сверка**
  (`PUT /chats/{id}/keys/verification`, `expected_key_generation` = новый);
- после accept отправка идёт в **новой prekey-сессии** (OPK −1, envelope
  `prekey IS NOT NULL`), а старая сессия остаётся на диске, но не используется;
- key-change сценарий: **2/2** (Chromium 6.8 s, Firefox 7.8 s);
  F7B без gate: **2/2** (Chromium 7.0 s, Firefox 10.6 s), key-change — 2 skipped;
- `npm run check` — **EXIT 0**, 81 файл / **867 тестов** (было 865), build 445
  модулей; overlay/base образы и asset зафиксированы ниже.

По ходу live-сценария найдены и минимально исправлены **два реальных бага**
(§4): после accept отправка навсегда падала с `KEY_CHANGE_DETECTED` из-за
старой сессии, а уже расшифрованная входящая история исчезала под key-change
баннером, что противоречит §7.5. Оба фикса покрыты committed unit-тестами,
которые падают на pre-fix коде.

**Статус #31: DONE.** Условие 4 в части key-change/TOFU/verified reset закрыто.
Остальные клаузы условия 4 (`L3b` receiver-дедуп — v1.1 wire; multi-device
E2E сверх двух реальных устройств) в #31 не входили и остаются открытыми для
отдельных задач; F7B покрывает два реальных устройства A/B.

## 2. Live-сценарий

### 2.1. Gate и запуск

Сценарий — второй `test()` в `frontend/e2e/e2ee.real.spec.ts`, поэтому он
использует те же `playwright.e2ee-real.config.ts` и overlay. Он не запускается
по умолчанию:

| Gate                                                        | Значение   | Смысл                               |
| ----------------------------------------------------------- | ---------- | ----------------------------------- |
| `E2EE_REAL=1`                                               | npm script | real-стек, иначе all skipped        |
| `E2EE_REAL_KEYCHANGE=1`                                     | явно       | включает negative key-change test   |
| `E2EE_REAL_RESET=1` (alias `E2EE_REAL_ALLOW_DESTRUCTIVE=1`) | явно       | разрешает destructive test-only SQL |
| `E2EE_REAL_DB_CHECK!=0`                                     | default    | нужен psql для мутации/проверок     |

Без `E2EE_REAL_KEYCHANGE=1` F7B остаётся ровно `2 passed` (key-change — `2 skipped`).
`E2EE_REAL_KEYCHANGE=1` без destructive opt-in/DB — явный skip с сообщением, а не
тихая мутация.

```bash
cd frontend
E2EE_REAL_KEYCHANGE=1 E2EE_REAL_RESET=1 \
E2EE_REAL_USER_A_EMAIL=e2ee-kc-a-$(date +%s)@krug.local \
E2EE_REAL_USER_B_EMAIL=e2ee-kc-b-$(date +%s)@krug.local \
PLAYWRIGHT_BROWSERS_PATH=./.playwright-browsers \
TMPDIR=$PWD/.pw-tmp CFFIXED_USER_HOME=$PWD/.pw-home \
MOZ_DISABLE_CONTENT_SANDBOX=1 MOZ_DISABLE_GPU_SANDBOX=1 \
npm run test:e2e:e2ee:real -- -g "negative key change"
```

### 2.2. Шаги и проверки

1. **Fixture.** A и B создаются/переиспользуются через реальный BFF
   (`/auth/register` → Mailpit TOTP → `/auth/verify-email`, см. #29). Из-за
   destructive SQL обязателен `E2EE_REAL_RESET=1`: до login отзываются старые
   ACTIVE-устройства fixture-пользователей, удаляются stale
   `E2EE F7B …` workspace. Логинятся два реальных браузерных контекста, каждый
   регистрирует keyed device + prekeys; создаётся уникальный
   `E2EE F7B KEYCHANGE <ts>-<rand>` workspace, B добавляется через E12 members.
2. **Базовый E2EE-обмен.** A создаёт DIRECT E2EE-чат; A→B и B→A отправляют по
   сообщению (только `envelopes`, `text` отсутствует), оба видят plaintext.
3. **Pre-change attestation.** A сверяет B через `SafetyNumberDialog` →
   `PUT /chats/{id}/keys/verification` (`vh_version=2`, `method=MANUAL`), видит
   «Сверено»; в `auth.key_verifications` появляется live-строка. Фиксируются:
   safety number, набор `session:` id в IndexedDB A, число доступных OPK B.
4. **Test-only rotation.** В третьем контексте B логинится как B и регистрирует
   **настоящий** второй keyed device (source). Затем одним SQL-транзакционным
   скриптом source identity-ключи/binding/fingerprint и его SPK/OPK переносятся
   на старый `device_id` B, `key_generation++`, live-верификации target
   отзываются, source-устройство удаляется. Старые ключи/prekeys B снимаются в
   snapshot для восстановления.
5. **Detection.** A делает reload. `GET /chats/{id}/keys` возвращает тот же
   `device_id` B с новыми ключами; локальный TOFU-pin не совпадает →
   `KEY_CHANGE_DETECTED`. UI: «Ключ безопасности изменился», кнопка «Принять
   новый ключ», статус устройства «Нужна повторная сверка».
6. **Blocked state.** Safety number изменился (fingerprint B другой). Send
   button disabled, composer note «Отправка в этом чате заблокирована.».
   Ввод текста + Enter не создаёт `POST /messages` (0 запросов). OPK B не
   изменился, набор `session:` id A побайтно тот же (сессия не удалена и не
   перезаписана). Уже расшифрованная история A и B остаётся видимой.
7. **Accept + re-verify.** «Принять новый ключ» очищает warning и сбрасывает
   локальный verified; диалог показывает «Не сверено». Реальная сверка снова
   отправляет `PUT /keys/verification`; `expected_key_generation` равен новому
   поколению, сервер возвращает `201 verified=true`, диалог — «Сверено».
8. **Post-accept send.** A отправляет новое сообщение. Оно уходит в **новой**
   prekey-сессии: `session:` id стало больше, старый id сохранён, OPK B
   уменьшился на 1, в `message.message_envelopes` у нового сообщения
   `prekey IS NOT NULL`.
9. **No plaintext.** Маркеры не встречаются в WS-кадрах, backend logs,
   `message.messages`/`message_envelopes`; все строки чата —
   `E2EE_PAIRWISE`, `body_ciphertext IS NULL`, `content_meta='{}'`.
10. **Cleanup.** В `finally` восстанавливаются старые identity-ключи/prekeys B,
    удаляются verifications target-устройства, workspace текущего прогона и его
    сообщения/envelopes; временный контекст закрывается.

### 2.3. Результаты прогонов

| Прогон                       | Результат                            | Длительности                    | Аннотации (JSON)                                             |
| ---------------------------- | ------------------------------------ | ------------------------------- | ------------------------------------------------------------ |
| key-change, Chromium+Firefox | **2 passed**, 0 skipped              | Chromium 6.80 s, Firefox 7.77 s | `A=registered/B=registered`; `reset on`; `device … gen 1->2` |
| F7B без gate                 | **2 passed, 2 skipped** (key-change) | Chromium 7.0 s, Firefox 10.6 s  | F7B-аннотации #29 без изменений                              |
| key-change, повторный прогон | **2 passed**                         | Chromium 9.0 s, Firefox 11.0 s  | `A=existing/B=existing`; reset отозвал 2 устройства          |

JSON evidence (`/tmp/kc.json`): `expected=2, skipped=0, unexpected=0, flaky=0`;
аннотации:

```
E2EE_FIXTURE_USERS => registered/reused via BFF+Mailpit: A=registered, B=registered
E2EE_KEYCHANGE_RESET => on: revoked 0 active fixture device(s), deleted 0 stale E2EE F7B row(s) (disposable stack only)
E2EE_KEYCHANGE_MUTATION => test-only SQL on disposable stack: device fdc126c5… kept its id,
  adopted source device 1632d328… identity keys/SPK, key_generation 1->2; old keys/SPK are restored in finally
```

Firefox-прогон той же серии: `A=existing, B=existing`, reset отозвал 2 устройства,
`device 0867fe5c… gen 1->2`.

## 3. Test-only rotation: устройство и точный риск

### 3.1. Почему SQL, а не штатная ротация

Продукт **намеренно не имеет** API in-place смены identity для существующего
`device_id`: `DeviceRegistrationService` либо находит устройство по той же
identity-паре, либо создаёт новое `device_id`; смена пары на существующем
`device_id` запрещена (§3.3.1 п. 3a). Поэтому «легитимной ротации» через API нет.
Сценарий использует разрешённую условием 4 альтернативу — контролируемую
SQL-мутацию на одноразовом стенде, но берёт **не самодельные** ключи, а
реальный keyed-материал production-клиента:

- source-контекст B регистрируется через обычный BFF/UI-flow, клиент сам
  генерирует Ed25519/X25519 identity, binding-подпись, SPK-подпись и OPK;
- SQL переносит этот материал на старый `device_id`, поэтому peer проверяет
  валидную binding-подпись и валидную SPK-подпись (никакого «доверьтесь тесту»);
- меняется только привязка `device_id → keys` + `key_generation`, что и является
  проверяемой моделью атаки/сброса.

### 3.2. Что именно делает SQL

`rotateDeviceIdentity(target, source)` (`frontend/e2e/e2ee-real-fixture.ts`),
одна транзакция:

1. `DELETE auth.device_prekeys WHERE device_id=target`;
2. `INSERT … SELECT` SPK/OPK source → target (валидны для новых ключей);
3. `UPDATE auth.key_verifications SET revoked_at=now() WHERE target_device_id=target`
   (аналог `key_generation++`-сброса, который делает `DeviceRevocationService`);
4. `DELETE auth.devices WHERE id=source` (освобождает unique index на identity
   keys, source prekeys каскадно удаляются);
5. `UPDATE auth.devices SET identity_*=source, fingerprint=source,
key_generation=old+1 WHERE id=target`.

`restoreDeviceIdentity(snapshot)` в `finally` возвращает точные старые
identity-ключи/binding/fingerprint/`key_generation` и prekey-строки, затем
удаляет verifications target; workspace удаляется штатным `deleteWorkspace`.

### 3.3. Точный риск

- SQL обходит `DeviceRegistrationService`/`DeviceRevocationService`:
  **не** пишется `chat.keys.changed`/`device.list.changed`, нет
  `IDENTITY_KEY_CHANGED` audit/epoch-события. Именно поэтому peer обязан
  заметить подмену через TOFU-пин, а не через серверное уведомление — это и
  проверяется.
- Пока идёт сценарий, у fixture-устройства B серверная identity не совпадает с
  локальными приватными ключами старого таба B. Старый таб B после мутации
  **не используется** для отправки/расшифровки: это ожидаемое состояние
  «устройство потеряло/сменило ключи», а не продуктовая ротация.
- Мутация разрешена только при `E2EE_REAL_KEYCHANGE=1` **и**
  `E2EE_REAL_RESET=1` **и** доступном psql. Это одноразовый overlay-стенд;
  запускать на общем/производственном стенде нельзя.
- При падении процесса до `finally` устройство B останется мутированным.
  Следующий прогон с `E2EE_REAL_RESET=1` отзывает все ACTIVE-устройства
  fixture-пользователей и удаляет stale workspaces, но до этого момента
  стенд считается грязным. В отчёте Playwright cleanup-ошибка видна как
  `E2EE_KEYCHANGE_RESTORE_FAILED`/`E2EE_REAL_CLEANUP_FAILED`.
- В конце последнего прогона проверено: у `e2ee-kc-*` активные устройства имеют
  `key_generation=1`, prekeys восстановлены (1 SPK + 100 OPK, 99 unconsumed),
  `E2EE F7B KEYCHANGE` workspace = 0, verifications для этих пользователей = 0.

## 4. Найденные production-баги и минимальные фиксы

Оба бага воспроизведены committed-тестами **до** фикса (тесты падали) и
покрыты после. Wire/crypto/contracts не менялись.

### 4.1. После accept отправка навсегда падала `KEY_CHANGE_DETECTED`

**Симптом.** Если у A уже была ratchet-сессия с B, то после
`KEY_CHANGE_DETECTED` → «Принять новый ключ» → повторная сверка отправка всё
равно падала с `KEY_CHANGE_DETECTED` («session peer identity keys no longer
match the device keys»). Кнопка отправки выглядела разблокированной, но
`POST /messages` не уходил.

**Причина.** `prepareSend` выбирал старую сессию из
`listSessionsByPeer(...)`; `assertSessionMatchesIdentity` затем сравнивал
`session.peerIkSig/Dh` (старые ключи) с уже принятыми новыми ключами и бросал
ошибку. Сессия не удалялась и не пересоздавалась.

**Фикс** (`frontend/src/e2ee/app/chatBridge.ts`): при выборе сессии для отправки
исключаются сессии, чьи `peerIkSig`/`peerIkDh` не совпадают с текущими
(принятыми) ключами устройства. Тогда создаётся новая prekey-сессия, а старая
остаётся на диске (история не удаляется). `assertNotBlocked` по-прежнему
срабатывает **до** этого места, поэтому до accept отправка по-прежнему
заблокирована.

**Regression:** `src/e2ee/app/chatBridge.test.ts` — «does not reuse a
pre-change session after the accepted new key»: Bob→Alice создаёт сессию,
ключи B меняются, send блокируется, сессия не меняется, после accept создаётся
новая prekey-сессия (2 session id, старый сохранён).

### 4.2. Key-change прятал уже расшифрованную входящую историю

**Симптом.** После reload под `KEY_CHANGE_DETECTED` исходящее сообщение A
оставалось видимым, а уже расшифрованное входящее от B превращалось в
«Не удалось расшифровать сообщение». §7.5 требует: «Старые сообщения, уже
расшифрованные, остаются; новые — только после подтверждения».

**Причина.** `E2EE_COPY_RESTORE_CODES` в `chatStore.ts` не включал
`KEY_CHANGE_DETECTED`, поэтому sealed incoming copy не восстанавливалась:
`bridge.receive` под блокировкой сразу возвращал `KEY_CHANGE_DETECTED`, и
история заменялась error-view.

**Фикс** (`frontend/src/store/chatStore.ts`): `KEY_CHANGE_DETECTED` добавлен в
copy-restore set. Восстанавливается только **уже существующая** sealed-копия,
привязанная к `(chat, direction, sender device, client_message_id, message.id)`;
новое сообщение под изменённым ключом копии не имеет и по-прежнему рендерится
как blocking error до accept. Send guard и ceremony не ослаблены.

**Regression:** `src/store/e2eeChat.test.ts` — «keeps already decrypted history
visible while a key change blocks new rows».

## 5. Проверки

### 5.1. `npm run check`

```
lint                  ok (0 errors, 3 pre-existing warnings: CreateChatDialog.tsx,
                          chatBridgeSupport.test.ts)
format:check          ok
contract:check        ok
stickers:check        ok
security:check        ok (279 files)
session-writers:check ok (191 production files)
vitest                81 files / 867 tests passed   (+2 к базовым 865)
tsc --noEmit          clean
vite build            445 modules, built
EXIT 0
```

KAT/crypto не менялись (`vectors.test.ts`, `kStorageKAT.test.ts`,
`sessionKAT.test.ts` входят в 867).

### 5.2. Playwright listing

`npx playwright test --config playwright.e2ee-real.config.ts --list` — 4 tests /
1 file (F7B + key-change, Chromium/Firefox). Без `E2EE_REAL_KEYCHANGE=1`
key-change тесты skipped, F7B — 2/2.

### 5.3. Overlay/base артефакты

| Что                         | Overlay-прогон                                                                                        | Base после восстановления                                                                             |
| --------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| backend `KRUG_E2EE_ENABLED` | `true`                                                                                                | `false`                                                                                               |
| SPA flag                    | `VITE_E2EE_ENABLED:"true"`                                                                            | `VITE_E2EE_ENABLED:"false"`                                                                           |
| image                       | `sha256:07dbc22ba90c5aab1dd20463da5e2c2ad2790a0ec297d40fde8b046c972f690d`                             | `sha256:1de6d911e499b0629745272444af9142f61bbfea5f17bc9cb4623eaf031e43c1`                             |
| asset                       | `assets/index-BkHqkQZb.js`, sha256 `ba2c992176752763ad9b90750f0ab6fa179c56d26e1432b525cd7385531bf818` | `assets/index-uGIjhkd3.js`, sha256 `1ed31204aa843a527fcf1f3369ce070a953872792638007c6b9575e671511720` |
| `/api/v1/health`            | `200`                                                                                                 | `200`                                                                                                 |
| base `deploy/.env`          | не менялся                                                                                            | `KRUG_E2EE_ENABLED=false`                                                                             |

### 5.4. Секреты/plaintext

В отчёт/логи не попадают пароли, TOTP, токены и plaintext. Ассерты —
count-based; опциональный `E2EE_REAL_DEBUG` печатает только количества
элементов/статусы, не текст сообщений. WS-кадры и backend logs проверяются
на отсутствие маркеров in-memory.

## 6. Файлы

Новые:

- `frontend/E2EE-PILOT-3-REPORT.md` — этот отчёт.

Изменены (только `frontend/**`):

- `frontend/e2e/e2ee-real-fixture.ts` — `E2EE_REAL_KEYCHANGE` gate, snapshot/
  rotate/restore test-only SQL, OPK/verification count helpers;
- `frontend/e2e/e2ee.real.spec.ts` — второй gated key-change тест,
  `readE2eeSessionIds`, count-only diagnostics;
- `frontend/src/e2ee/app/chatBridge.ts` — не переиспользовать pre-change
  сессию после accept;
- `frontend/src/e2ee/app/chatBridge.test.ts` — committed regression (4.1);
- `frontend/src/store/chatStore.ts` — восстанавливать sealed copy для
  `KEY_CHANGE_DETECTED`;
- `frontend/src/store/e2eeChat.test.ts` — committed regression (4.2);
- `frontend/README.md` — gate/команда/риски key-change сценария.

Не изменялись: `backend/**`, `contracts/**`, `docs/**`, `design/**`,
`schema.d.ts`, base-флаги, compose-файлы, crypto/KAT/vectors/wire.

## 7. Остаточные риски / ограничения

1. **Нет продуктовой in-place ротации identity.** SQL-фикстура — единственный
   способ смоделировать key change; она обходит серверный epoch/audit/WS и
   допустима только на одноразовом стенде (§3.3). Это ограничение продукта, а
   не теста.
2. **Crash до `finally`** оставляет B-устройство мутированным до следующего
   `E2EE_REAL_RESET=1`; отчёт Playwright помечает restore/cleanup failure.
3. **Старый таб B после мутации недееспособен** (его приватные ключи не
   соответствуют серверу) и в сценарии не используется. Post-accept сообщение A
   адресовано новым ключам B; расшифровка на старом табе B не проверяется —
   это ожидаемый артефакт тестовой подмены, не продуктовая ротация.
4. **Copy-restore для `KEY_CHANGE_DETECTED`** показывает только уже
   расшифрованные копии; новые строки под изменённым ключом остаются
   error/blocked до accept. Копия привязана к server `message.id` и
   `client_message_id` (P2-04), поэтому replay старого client id под новым row
   не восстановится.
5. **`KEYCHANGE` требует DB/reset.** На удалённом стеке
   (`E2EE_REAL_DB_CHECK=0`) сценарий явно skipped; это осознанно, потому что
   без SQL нет способа сменить identity на том же `device_id`.
6. **L3b/multi-device клаузы условия 4** не входят в #31: receiver-дедуп
   `retry_of_client_message_id` — v1.1 wire-решение, multi-device сверх двух
   реальных устройств — отдельный E2E. F7B по-прежнему покрывает два реальных
   устройства A/B и не затронут.
7. **Fixture-пользователи накапливаются** (`e2ee-kc-*@krug.local`, 14 за
   прогоны этой задачи). Удаление пользователей не входило в #31; для CI нужен
   reset стенда/чистая БД.
8. **Firefox в песочнице DSH** требует `TMPDIR`/`CFFIXED_USER_HOME` и
   отключения sandbox — артефакт среды, не проекта.

---

**Статус #31: DONE.** Negative key-change/TOFU live + verified reset закрыты
на реальном overlay-стеке: 2/2 Chromium/Firefox, F7B 2/2 без gate, оба фикса
покрыты committed-тестами (867/867), `npm run check` EXIT 0, base-стек
восстановлен (`KRUG_E2EE_ENABLED=false`, SPA flag false, health 200).
