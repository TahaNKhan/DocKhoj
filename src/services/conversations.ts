import type Database from 'better-sqlite3';

type DB = Database.Database;

// ConversationStore — SQLite-backed persistence for chat sessions and
// messages. Replaces the Phase 01 in-memory Map; survives container
// restarts (per FR-7, U3, U8).
//
// Schema: see src/db/migrations/001_init.sql and 002_title_source.sql.
//
// Conventions:
// - Timestamps are stored as SQLite TEXT ('YYYY-MM-DD HH:MM:SS' UTC).
//   Returned to the API as opaque strings; the client formats them
//   for display.
// - `id` is a UUIDv4 throughout (server-generated). Matches the
//   existing regex ^[A-Za-z0-9_-]{1,64}$ so the existing sessionId
//   validator stays valid.
// - All write paths run inside implicit better-sqlite3 transactions
//   (single .run/.exec) — atomic per statement. Multi-statement writes
//   (rename + bump) use explicit db.transaction() blocks.

export interface Conversation {
  id: string;
  title: string;
  titleSource: 'default' | 'generated' | 'fallback' | 'user';
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface Message {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  sources?: Source[];
  createdAt: string;
}

export interface Source {
  fileName: string;
  filePath: string;
  chunk: string;
  pageNumber?: number;
  headingPath?: string[];
  score: number;
}

type TitleSource = Conversation['titleSource'];

export class ConversationStore {
  constructor(private readonly db: DB) {}

  // ----- Conversations -----

  list(): Conversation[] {
    const rows = this.db
      .prepare(
        `SELECT c.id, c.title, c.title_source, c.created_at, c.updated_at,
                COUNT(m.id) AS message_count
         FROM conversations c
         LEFT JOIN messages m ON m.conversation_id = c.id
         GROUP BY c.id
         ORDER BY c.updated_at DESC`
      )
      .all() as Array<{
      id: string;
      title: string;
      title_source: string;
      created_at: string;
      updated_at: string;
      message_count: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      titleSource: r.title_source as TitleSource,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      messageCount: r.message_count,
    }));
  }

  get(id: string): Conversation | null {
    const row = this.db
      .prepare(
        `SELECT c.id, c.title, c.title_source, c.created_at, c.updated_at,
                COUNT(m.id) AS message_count
         FROM conversations c
         LEFT JOIN messages m ON m.conversation_id = c.id
         WHERE c.id = ?
         GROUP BY c.id`
      )
      .get(id) as
      | {
          id: string;
          title: string;
          title_source: string;
          created_at: string;
          updated_at: string;
          message_count: number;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      title: row.title,
      titleSource: row.title_source as TitleSource,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      messageCount: row.message_count,
    };
  }

  create(): Conversation {
    const id = uuidv4();
    this.db
      .prepare(
        `INSERT INTO conversations (id, title, title_source) VALUES (?, 'New chat', 'default')`
      )
      .run(id);
    return this.get(id)!;
  }

  /**
   * User-initiated rename (PATCH /api/sessions/:id). Always wins.
   * Sets title_source = 'user' so future LLM-generated titles
   * cannot overwrite (FR-15b). Returns the new conversation, or null
   * if the id doesn't exist.
   */
  rename(id: string, title: string): Conversation | null {
    if (!title.trim()) return null;
    const result = this.db
      .prepare(
        `UPDATE conversations
         SET title = ?, title_source = 'user', updated_at = datetime('now')
         WHERE id = ?`
      )
      .run(title.trim(), id);
    if (result.changes === 0) return null;
    return this.get(id);
  }

  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
    return result.changes > 0;
  }

  // ----- Messages -----

  appendUserMessage(conversationId: string, content: string): Message {
    const msg: Message = {
      id: uuidv4(),
      conversationId,
      role: 'user',
      content,
      createdAt: nowIso(),
    };
    this.writeMessage(msg);
    this.bumpUpdatedAt(conversationId);
    return this.readMessage(msg.id)!;
  }

  appendAssistantMessage(
    conversationId: string,
    content: string,
    sources: Source[]
  ): Message {
    const msg: Message = {
      id: uuidv4(),
      conversationId,
      role: 'assistant',
      content,
      sources,
      createdAt: nowIso(),
    };
    this.writeMessage(msg);
    this.bumpUpdatedAt(conversationId);
    return this.readMessage(msg.id)!;
  }

  listMessages(conversationId: string): Message[] {
    const rows = this.db
      .prepare(
        `SELECT id, conversation_id, role, content, sources, created_at
         FROM messages
         WHERE conversation_id = ?
         ORDER BY created_at ASC, rowid ASC`
      )
      .all(conversationId) as Array<{
      id: string;
      conversation_id: string;
      role: 'user' | 'assistant';
      content: string;
      sources: string | null;
      created_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      conversationId: r.conversation_id,
      role: r.role,
      content: r.content,
      sources: r.sources ? (JSON.parse(r.sources) as Source[]) : undefined,
      createdAt: r.created_at,
    }));
  }

  bumpUpdatedAt(conversationId: string): void {
    this.db
      .prepare(`UPDATE conversations SET updated_at = datetime('now') WHERE id = ?`)
      .run(conversationId);
  }

  // ----- Title management (FR-14, FR-15b) -----

  /**
   * Set a title produced by the LLM title generator. Refuses to
   * overwrite a user-renamed title (title_source = 'user') or an
   * already-generated title (preserves the most recent winning LLM
   * title if the generator was invoked again for some reason).
   *
   * Returns true if the title was persisted, false if it was rejected
   * (because the session's current title is 'user'-sourced or 'generated').
   */
  setGeneratedTitle(conversationId: string, title: string): boolean {
    const current = this.get(conversationId);
    if (!current) return false;
    if (current.titleSource === 'user') return false;
    if (current.titleSource === 'generated') return false;
    // current titleSource is 'default' or 'fallback' — safe to overwrite
    this.db
      .prepare(
        `UPDATE conversations
         SET title = ?, title_source = 'generated', updated_at = datetime('now')
         WHERE id = ? AND title_source IN ('default', 'fallback')`
      )
      .run(title.trim(), conversationId);
    return true;
  }

  /**
   * Set a fallback title (60-char user-prefix). Most restrictive —
   * only overwrites 'default'.
   */
  setFallbackTitle(conversationId: string, title: string): boolean {
    const current = this.get(conversationId);
    if (!current) return false;
    if (current.titleSource !== 'default') return false;
    this.db
      .prepare(
        `UPDATE conversations
         SET title = ?, title_source = 'fallback', updated_at = datetime('now')
         WHERE id = ? AND title_source = 'default'`
      )
      .run(title.trim(), conversationId);
    return true;
  }

  // ----- Internals -----

  private writeMessage(msg: Message): void {
    this.db
      .prepare(
        `INSERT INTO messages (id, conversation_id, role, content, sources, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        msg.id,
        msg.conversationId,
        msg.role,
        msg.content,
        msg.sources ? JSON.stringify(msg.sources) : null,
        msg.createdAt
      );
  }

  private readMessage(id: string): Message | null {
    const row = this.db
      .prepare(
        `SELECT id, conversation_id, role, content, sources, created_at
         FROM messages WHERE id = ?`
      )
      .get(id) as
      | {
          id: string;
          conversation_id: string;
          role: 'user' | 'assistant';
          content: string;
          sources: string | null;
          created_at: string;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      conversationId: row.conversation_id,
      role: row.role,
      content: row.content,
      sources: row.sources ? (JSON.parse(row.sources) as Source[]) : undefined,
      createdAt: row.created_at,
    };
  }
}

// ----- Helpers -----

import { v4 as uuidv4 } from 'uuid';

function nowIso(): string {
  return new Date()
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, '');
}
