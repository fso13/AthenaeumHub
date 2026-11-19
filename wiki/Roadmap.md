# Roadmap и статус

Статус ведётся в GitHub Issues и [ROADMAP #58](https://github.com/fso13/AthenaeumHub/issues/58).

## Сделано

Managed MVP: auth BFF, чаты, файлы, стикеры, realtime, уведомления, admin (users/chats/storage/actions/audit),
workspace members, DIRECT, LDAP guide, media, бренд Сова, deploy, QA.

E2EE: backend B1–B4, client F1–F6, F7A browser KAT, F7B two-device, F8 P1 closure, G4 review.
Флаг **false**.

## Очередь

### E2EE pilot (P0)

- #29 clean-stack F7B fixture — **DONE**
- #30 durable retry/drain — **DONE**
- #31 negative key-change/TOFU live — **DONE**
- #32 receiver R-15 v1.1 — **DONE** (optional TEXT marker, receiver dedupe)
- #33 Safari/iOS gate — open
- #34 vectors v1.1 — **DONE** (v5, 272..33040)
- #35 CI/checklist/release — **DONE**
- #36 legacy sendOrder/supersededAt — open
- #37 kill-switch/retention/rollout — **DONE**
- #38 enable flag — **blocked**

### Hardening

- #39 HttpOnly refresh cookie
- #40 Keycloak service account
- #41 real SMTP
- #42 V19/V20 runbook
- #43 backup/restore
- #44 TLS/reverse proxy
- #45 workspace invitations

### D1 Dashboard v1.0

- MVP #46–#56 — **DONE**: threads, rail/99+, pages, voice/media/ID3, settings/profile, e2e.
- #57 D1.1 — queued: E2EE threads, server media extraction, player/playlists.

## Milestones

- MVP delivered
- E2EE pilot
- D1 Dashboard v1.0
- Hardening v1.1

## Правило

`status: done` + closed — только с evidence; `blocked` — с указанием blocker.
