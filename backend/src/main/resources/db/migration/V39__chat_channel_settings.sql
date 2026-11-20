-- GROUP channel visibility (additive): PUBLIC channels are workspace-wide and every
-- future ACTIVE workspace member joins automatically; PRIVATE channels contain only the
-- creator and the selected ACTIVE members.
--
-- The settings row is separate from chat.chats so DIRECT chats keep no visibility and the
-- existing V3/V38 schema stays untouched. Every GROUP chat created before this migration
-- was workspace-wide (V38 backfilled all ACTIVE members), therefore the backfill is PUBLIC.

CREATE TABLE chat.channel_settings (
  chat_id     uuid PRIMARY KEY REFERENCES chat.chats(id) ON DELETE CASCADE,
  visibility  text NOT NULL CHECK (visibility IN ('PUBLIC', 'PRIVATE')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE chat.channel_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat.channel_settings FORCE ROW LEVEL SECURITY;

-- channel_settings has no workspace_id of its own (the contract is chat_id PK). The policy
-- follows the owning chat, which is itself FORCE-RLS-scoped to the same workspace GUC, so a
-- row is visible only inside the workspace of its chat. The app role can never read or write
-- another tenant's visibility row even without the HTTP membership guard.
CREATE POLICY p_channel_settings_tenant ON chat.channel_settings
  USING (EXISTS (
      SELECT 1
        FROM chat.chats c
       WHERE c.id = chat_id
         AND c.workspace_id = ops.current_workspace_id()
  ))
  WITH CHECK (EXISTS (
      SELECT 1
        FROM chat.chats c
       WHERE c.id = chat_id
         AND c.workspace_id = ops.current_workspace_id()
  ));

GRANT SELECT, INSERT, UPDATE, DELETE ON chat.channel_settings TO krug_app;

-- Existing GROUP chats were created as workspace-wide channels before this feature.
INSERT INTO chat.channel_settings (chat_id, visibility, created_at)
SELECT c.id, 'PUBLIC', COALESCE(c.created_at, now())
  FROM chat.chats c
 WHERE c.type = 'GROUP'
ON CONFLICT (chat_id) DO NOTHING;

COMMENT ON TABLE chat.channel_settings IS
  'GROUP channel visibility (PUBLIC workspace-wide / PRIVATE selected members).';
COMMENT ON COLUMN chat.channel_settings.visibility IS
  'PUBLIC: all ACTIVE workspace members and future joins; PRIVATE: creator + selected.';

-- Forward-only rollback plan:
--   DROP TABLE chat.channel_settings;
-- Visibility data is lost on rollback; chats, members and messages are untouched.
