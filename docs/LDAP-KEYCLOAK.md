# LDAP / Active Directory / FreeIPA через Keycloak

Сова не хранит корпоративные пароли. Аутентификация LDAP/AD/FreeIPA выполняется
Keycloak User Federation, а BFF Совы (`POST /auth/login`) получает токены Keycloak.

## 1. Что нужно от LDAP

| Параметр | Пример | Примечание |
|---|---|---|
| LDAP URL | `ldaps://ldap.example.com:636` | Только TLS: LDAPS или StartTLS |
| Bind DN | `cn=sova-bind,ou=services,dc=example,dc=com` | Read-only service account |
| Bind password | секрет | Хранится в Keycloak, не в Сове |
| Users DN | `ou=people,dc=example,dc=com` | База поиска пользователей |
| Groups DN | `ou=groups,dc=example,dc=com` | Если нужны группы |
| Email attribute | `mail` | Обязателен для Совы |
| Display attribute | `displayName` / `cn` | Для UI |
| Username attribute | `uid` (FreeIPA) / `sAMAccountName` (AD) | Уникальный логин |

Проверка bind из контейнера Keycloak:

```bash
ldapsearch -H ldaps://ldap.example.com:636 \
  -D 'cn=sova-bind,ou=services,dc=example,dc=com' -W \
  -b 'ou=people,dc=example,dc=com' '(mail=user@example.com)' mail cn uid
```

## 2. Keycloak User Federation

1. Admin Console → realm `krug` → **User federation** → **Add LDAP**.
2. **Connection**:
   - Vendor: `Active Directory` / `FreeIPA` / `Other`
   - Connection URL: `ldaps://...:636`
   - Enable StartTLS, если используется `ldap://:389`
   - Bind type: `simple`
   - Bind DN / Bind credential
   - Edit mode: `READ_ONLY` (рекомендуется) или `UNSYNCED`
3. **LDAP searching and updating**:
   - Users DN: `ou=people,...`
   - Username LDAP attribute: `uid` (FreeIPA) / `sAMAccountName` (AD)
   - RDN LDAP attribute: `uid` / `cn`
   - UUID LDAP attribute: `nsUniqueId` (FreeIPA/389) / `objectGUID` (AD)
   - User object classes: `inetOrgPerson, organizationalPerson` (FreeIPA) / `person, organizationalPerson, user` (AD)
4. **Synchronization**: Import users / Periodic sync; для AD учесть paged results.
5. **Mappers** (обязательно):
   - `email` → `mail` (важно: без email Сова не сможет создать профиль)
   - `firstName` → `givenName`
   - `lastName` → `sn`
   - `displayName` → `displayName`/`cn`
   - `username` → LDAP username
   - Group mapper → `memberOf`/`member` (опционально)
6. **Email verified / Trust Email**: для LDAP/AD-каталога включите
   **Trust Email** в настройках User Federation (Keycloak помечает импортированный
   email как verified). Иначе BFF Совы отправит TOTP-подтверждение, а у LDAP-пользователя
   может не быть такого сценария. Не включайте Trust Email для недоверенного каталога.
   При первом входе BFF Совы делает JIT provisioning; email нужен для `/me`.

## 3. Регистрация и вход

- Вход — через форму Совы `POST /auth/login`; Keycloak проверяет пароль в LDAP.
- Самостоятельная регистрация для LDAP-доменов обычно **закрывается**:
  `registration_open=false` в `/admin/settings` или Keycloak realm registration off.
- Если LDAP-пользователь входит впервые, Сова создаёт локальный профиль (JIT), но
  пароль остаётся в LDAP; в БД Совы пароля нет.
- Keycloak user federation не импортирует пароли; смена пароля — в LDAP/AD/FreeIPA.

## 4. AD specifics

- Используйте `ldaps://` или StartTLS; AD часто требует `DC=...` bind.
- Username: `sAMAccountName`; UUID: `objectGUID`.
- Email: `mail`; если пуст — заполните в AD или добавьте fallback-mapper
  `userPrincipalName`.
- Группы: `memberOf` (AD); для больших каталогов — group mapper с фильтром.
- Bind-аккаунт: read-only, без смены пароля; ограничить по OU.

## 5. FreeIPA specifics

- URL: `ldaps://ipa.example.com:636`; bind DN вида `uid=sova,cn=sysaccounts,cn=etc,dc=example,dc=com`.
- Username: `uid`; UUID: `nsUniqueId`; email: `mail`.
- Группы: `memberOf`; для POSIX-групп — отдельный mapper.
- FreeIPA часто требует `TLS_REQCERT`; используйте корпоративный CA в truststore Keycloak.

## 6. Проверка

1. Keycloak Admin Console → Users → **View all users** / Sync.
2. Найдите LDAP-пользователя, проверьте email/displayName.
3. Выйдите из Совы, войдите через форму Совы с LDAP-логином/паролем.
4. `GET /me` должен вернуть email и display name.
5. Неверный пароль → `401 INVALID_CREDENTIALS`; пользователь без email → ошибка
   provisioning (исправьте mapper).

BFF login можно проверить напрямую:

```bash
curl -sS -X POST http://localhost:8088/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"ldap.user@example.com","password":"..."}'
```

Keycloak direct grant использует email как username; если LDAP username не email,
BFF всё равно отправляет email в `username` — Keycloak ищет по `loginWithEmailAllowed`.
Для AD, где email и sAMAccountName различаются, включите `loginWithEmailAllowed`
или используйте `userPrincipalName` как username/email mapper.

## 7. Troubleshooting

| Симптом | Причина |
|---|---|
| `401 invalid_grant` | Неверный пароль, LDAP bind, TLS или user не найден |
| `Account is not fully set up` | Нет email/имени; проверьте mappers |
| Пользователь не находится | Users DN/фильтр/objectClass; запустите sync |
| `LDAP: error code 49` | Bind DN/пароль или ACL |
| `LDAP: error code 32` | Неверный base DN |
| Долгий вход | Нет paged results/индекса по `mail`; проверьте каталог |

## 8. Безопасность

- Только LDAPS/StartTLS; не открывайте 389 в интернет.
- Bind-аккаунт read-only, минимальные права, отдельный от админского.
- Пароль bind — в Keycloak/Vault, не в Git/`.env` Сова.
- Не включайте LDAP debug с паролями в проде.
- Keycloak User Federation не даёт Сова доступ к LDAP-паролям.
