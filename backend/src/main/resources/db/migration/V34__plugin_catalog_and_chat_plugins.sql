-- D1.1 (#69): built-in plugin catalog and per-chat enablement state.
--
-- Scope:
--   * plugin.catalog is a global, curated list of first-party built-ins. There is no
--     marketplace, no manifest/version/signature and no arbitrary third-party install.
--   * chat.chat_plugins stores only the per-chat toggle (enabled/updated_by/updated_at).
--     Nothing here executes plugin code, calls external services or stores secrets.
--   * The list is additive: it does not alter existing chat/message tables or grants.
--
-- Naming: V33 is occupied by the concurrent built-in sticker brand-rename migration, so
-- this additive plugin migration is V34.

CREATE SCHEMA IF NOT EXISTS plugin;
GRANT USAGE ON SCHEMA plugin TO krug_app;

CREATE TABLE plugin.catalog (
  id           text PRIMARY KEY
               CHECK (id ~ '^[a-z][a-z0-9-]{0,63}$'),
  name         text NOT NULL
               CHECK (length(name) BETWEEN 1 AND 120),
  description  text NOT NULL
               CHECK (length(description) BETWEEN 1 AND 500),
  -- Optional UI icon token. It is a closed, client-side name, never a URL or HTML.
  icon         text CHECK (icon IS NULL OR length(icon) BETWEEN 1 AND 64),
  -- Capability names shown to the user; never executable grants in this slice.
  permissions  text[] NOT NULL DEFAULT '{}'::text[]
               CHECK (permissions <@ ARRAY['MESSAGES', 'MEMBERS', 'FILES', 'WEBHOOKS']::text[]),
  -- MANAGED means the server-side contour; E2EE means a client-only plugin that could
  -- run without server access to plaintext. Current built-ins are MANAGED only.
  modes        text[] NOT NULL
               CHECK (cardinality(modes) BETWEEN 1 AND 2
                      AND modes <@ ARRAY['MANAGED', 'E2EE']::text[]),
  -- Catalog-level kill switch. DISABLED rows stay visible but cannot be enabled.
  state        text NOT NULL DEFAULT 'ACTIVE'
               CHECK (state IN ('ACTIVE', 'DISABLED')),
  sort_order   integer NOT NULL DEFAULT 100 CHECK (sort_order >= 0),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_plugin_catalog_state_order
  ON plugin.catalog (state, sort_order, id);

-- Global built-in catalog: readable by the runtime role, seeded only by the migrator.
GRANT SELECT ON plugin.catalog TO krug_app;

CREATE TABLE chat.chat_plugins (
  workspace_id uuid NOT NULL,
  chat_id      uuid NOT NULL REFERENCES chat.chats(id) ON DELETE CASCADE,
  plugin_id    text NOT NULL REFERENCES plugin.catalog(id) ON DELETE RESTRICT,
  enabled      boolean NOT NULL DEFAULT false,
  -- Audit-like actor reference: intentionally no FK, because deleting a user must not
  -- erase an active chat's plugin configuration.
  updated_by   uuid NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chat_id, plugin_id)
);

CREATE INDEX ix_chat_plugins_workspace_chat
  ON chat.chat_plugins (workspace_id, chat_id);
CREATE INDEX ix_chat_plugins_plugin
  ON chat.chat_plugins (plugin_id);

ALTER TABLE chat.chat_plugins ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat.chat_plugins FORCE ROW LEVEL SECURITY;
CREATE POLICY p_chat_plugins_tenant ON chat.chat_plugins
  USING (workspace_id = ops.current_workspace_id())
  WITH CHECK (workspace_id = ops.current_workspace_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON chat.chat_plugins TO krug_app;

-- Five built-in first-party plugins from the dashboard design. The `stickers` card in
-- the mock is intentionally not part of this catalog: it is a client-only surface and
-- this slice is a server-side, managed-only catalog.
INSERT INTO plugin.catalog
  (id, name, description, icon, permissions, modes, state, sort_order)
VALUES
  ('polls', 'Опросы',
   'Голосования и быстрые решения прямо в переписке.',
   'poll', ARRAY['MESSAGES', 'MEMBERS']::text[], ARRAY['MANAGED']::text[],
   'ACTIVE', 10),
  ('tasks', 'Задачи',
   'Чек-листы, дедлайны и напоминания в чате.',
   'task', ARRAY['MESSAGES']::text[], ARRAY['MANAGED']::text[],
   'ACTIVE', 20),
  ('translate', 'Перевод',
   'Перевод входящих сообщений на лету.',
   'translate', ARRAY['MESSAGES']::text[], ARRAY['MANAGED']::text[],
   'ACTIVE', 30),
  ('telegram', 'Мост в Telegram',
   'Двусторонний мост для внешних команд и подрядчиков.',
   'plug', ARRAY['MESSAGES', 'MEMBERS', 'WEBHOOKS']::text[], ARRAY['MANAGED']::text[],
   'ACTIVE', 40),
  ('dlp', 'DLP-подсказки',
   'Предупреждает об отправке чувствительных данных.',
   'shield', ARRAY['MESSAGES', 'FILES']::text[], ARRAY['MANAGED']::text[],
   'ACTIVE', 50)
ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE plugin.catalog IS
  'D1.1 built-in first-party plugin catalog. No marketplace, no execution.';
COMMENT ON TABLE chat.chat_plugins IS
  'D1.1 per-chat plugin toggle. State only; plugin code is never executed here.';
COMMENT ON COLUMN chat.chat_plugins.enabled IS
  'Requested state; availability additionally depends on the catalog state and chat mode.';
COMMENT ON COLUMN chat.chat_plugins.updated_by IS
  'Actor of the last effective toggle; no FK so user deletion cannot erase chat config.';

-- Forward-only rollback plan:
--   DROP TABLE chat.chat_plugins;
--   DROP TABLE plugin.catalog;
--   DROP SCHEMA plugin;
-- Plugin enablement state is lost on rollback; chats/messages/files are untouched.
