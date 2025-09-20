import { sql } from 'drizzle-orm';
import {
  sqliteTable,
  text,
  integer,
  real,
  index,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import {
  relations,
  type InferInsertModel,
  type InferSelectModel,
} from 'drizzle-orm';

/**
 * Notes
 * - All timestamps are Unix epoch seconds (INTEGER).
 * - Use migrations to create the FTS5 virtual table (chunks_fts) and triggers.
 * - All FK relations use ON DELETE CASCADE where safe to avoid orphan rows.
 */

/* --------------------------------- threads --------------------------------- */

export const threads = sqliteTable(
  'threads',
  {
    id: text('id').primaryKey(), // ULID
    title: text('title').notNull(),
    visitorId: text('visitor_id'), // optional anonymous visitor id
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(strftime('%s','now'))`),
  },
  (t) => ({
    createdIdx: index('idx_threads_created_at').on(t.createdAt),
  })
);

export type Thread = InferSelectModel<typeof threads>;
export type NewThread = InferInsertModel<typeof threads>;

/* -------------------------------- messages --------------------------------- */

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    threadId: text('thread_id')
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['user', 'assistant', 'system'] }).notNull(),
    contentMd: text('content_md').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(strftime('%s','now'))`),
  },
  (t) => ({
    threadIdx: index('idx_messages_thread_id').on(t.threadId),
    createdIdx: index('idx_messages_created_at').on(t.createdAt),
  })
);

export type Message = InferSelectModel<typeof messages>;
export type NewMessage = InferInsertModel<typeof messages>;

/* --------------------------------- sources --------------------------------- */

export const sources = sqliteTable(
  'sources',
  {
    id: text('id').primaryKey(),
    url: text('url').notNull().unique(),
    domain: text('domain').notNull(),
    title: text('title'),
    publishedAt: text('published_at'), // ISO if known
    crawledAt: text('crawled_at'), // ISO or epoch string if preferred
    lang: text('lang'),
    fingerprint: text('fingerprint').unique(), // content hash if you compute one
    wordCount: integer('word_count'),
    status: text('status'), // ok | failed | pending
    httpStatus: integer('http_status'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(strftime('%s','now'))`),
  },
  (t) => ({
    domainIdx: index('idx_sources_domain').on(t.domain),
    createdIdx: index('idx_sources_created_at').on(t.createdAt),
    urlUq: uniqueIndex('uq_sources_url').on(t.url),
    fpUq: uniqueIndex('uq_sources_fingerprint').on(t.fingerprint),
  })
);

export type Source = InferSelectModel<typeof sources>;
export type NewSource = InferInsertModel<typeof sources>;

/* ----------------------------- source_content ------------------------------ */

export const sourceContent = sqliteTable(
  'source_content',
  {
    sourceId: text('source_id')
      .primaryKey()
      .references(() => sources.id, { onDelete: 'cascade' }),
    text: text('text').notNull(), // normalized plaintext
    html: text('html'), // optional raw HTML
  },
  (t) => ({
    sourceIdx: index('idx_source_content_source_id').on(t.sourceId),
  })
);

export type SourceContent = InferSelectModel<typeof sourceContent>;
export type NewSourceContent = InferInsertModel<typeof sourceContent>;

/* ---------------------------------- chunks --------------------------------- */

export const chunks = sqliteTable(
  'chunks',
  {
    id: text('id').primaryKey(),
    sourceId: text('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    pos: integer('pos').notNull(), // 0-based order
    charStart: integer('char_start').notNull(),
    charEnd: integer('char_end').notNull(),
    text: text('text').notNull(),
    tokens: integer('tokens').notNull(), // approx token count
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(strftime('%s','now'))`),
  },
  (t) => ({
    sourceIdx: index('idx_chunks_source_id').on(t.sourceId),
    sourcePosIdx: index('idx_chunks_source_pos').on(t.sourceId, t.pos),
  })
);

export type Chunk = InferSelectModel<typeof chunks>;
export type NewChunk = InferInsertModel<typeof chunks>;

/**
 * FTS: create virtual table via migration:
 *   CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts
 *   USING fts5(text, content='chunks', content_rowid='rowid');
 * Plus triggers to sync on insert/update/delete.
 */

/* ------------------------------- search_events ----------------------------- */

export const searchEvents = sqliteTable(
  'search_events',
  {
    id: text('id').primaryKey(),
    threadId: text('thread_id').references(() => threads.id, { onDelete: 'cascade' }),
    query: text('query').notNull(),
    resultsJson: text('results_json').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(strftime('%s','now'))`),
  },
  (t) => ({
    threadIdx: index('idx_search_events_thread_id').on(t.threadId),
    createdIdx: index('idx_search_events_created_at').on(t.createdAt),
  })
);

export type SearchEvent = InferSelectModel<typeof searchEvents>;
export type NewSearchEvent = InferInsertModel<typeof searchEvents>;

/* --------------------------------- citations ------------------------------- */

export const citations = sqliteTable(
  'citations',
  {
    id: text('id').primaryKey(),
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    sourceId: text('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    chunkId: text('chunk_id').references(() => chunks.id, { onDelete: 'set null' }),
    quote: text('quote').notNull(),
    charStart: integer('char_start'),
    charEnd: integer('char_end'),
    rankScore: real('rank_score'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(strftime('%s','now'))`),
  },
  (t) => ({
    msgIdx: index('idx_citations_message_id').on(t.messageId),
    srcIdx: index('idx_citations_source_id').on(t.sourceId),
    chunkIdx: index('idx_citations_chunk_id').on(t.chunkId),
  })
);

export type Citation = InferSelectModel<typeof citations>;
export type NewCitation = InferInsertModel<typeof citations>;

/* ----------------------------------- claims -------------------------------- */

export const claims = sqliteTable(
  'claims',
  {
    id: text('id').primaryKey(),
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    claimType: text('claim_type'), // quant | causal | definition | opinion | other
    supportScore: real('support_score').notNull(), // 0..1
    contradicted: integer('contradicted', { mode: 'boolean' })
      .notNull()
      .default(false),
    uncertaintyReason: text('uncertainty_reason'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(strftime('%s','now'))`),
  },
  (t) => ({
    msgIdx: index('idx_claims_message_id').on(t.messageId),
  })
);

export type Claim = InferSelectModel<typeof claims>;
export type NewClaim = InferInsertModel<typeof claims>;

/* ------------------------------- claim_evidence ---------------------------- */

export const claimEvidence = sqliteTable(
  'claim_evidence',
  {
    id: text('id').primaryKey(),
    claimId: text('claim_id')
      .notNull()
      .references(() => claims.id, { onDelete: 'cascade' }),
    sourceId: text('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    chunkId: text('chunk_id')
      .notNull()
      .references(() => chunks.id, { onDelete: 'cascade' }),
    quote: text('quote').notNull(),
    charStart: integer('char_start').notNull(),
    charEnd: integer('char_end').notNull(),
    score: real('score'), // optional confidence per-evidence
  },
  (t) => ({
    claimIdx: index('idx_claim_evidence_claim_id').on(t.claimId),
    srcIdx: index('idx_claim_evidence_source_id').on(t.sourceId),
    chunkIdx: index('idx_claim_evidence_chunk_id').on(t.chunkId),
  })
);

export type ClaimEvidence = InferSelectModel<typeof claimEvidence>;
export type NewClaimEvidence = InferInsertModel<typeof claimEvidence>;

/* -------------------------------- ingest_queue ----------------------------- */

export const ingestQueue = sqliteTable(
  'ingest_queue',
  {
    id: text('id').primaryKey(),
    url: text('url').notNull(),
    priority: integer('priority').notNull().default(0),
    status: text('status').notNull().default('queued'), // queued | processing | done | error
    attempts: integer('attempts').notNull().default(0),
    error: text('error'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(strftime('%s','now'))`),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(strftime('%s','now'))`),
  },
  (t) => ({
    statusIdx: index('idx_ingest_queue_status').on(t.status),
    urlIdx: index('idx_ingest_queue_url').on(t.url),
  })
);

export type IngestQueue = InferSelectModel<typeof ingestQueue>;
export type NewIngestQueue = InferInsertModel<typeof ingestQueue>;

/* -------------------------------- relations -------------------------------- */

export const threadsRelations = relations(threads, ({ many }) => ({
  messages: many(messages),
  searchEvents: many(searchEvents),
}));

export const messagesRelations = relations(messages, ({ one, many }) => ({
  thread: one(threads, {
    fields: [messages.threadId],
    references: [threads.id],
  }),
  citations: many(citations),
  claims: many(claims),
}));

export const sourcesRelations = relations(sources, ({ one, many }) => ({
  // FIXED: fields must be from 'sources'; references must be to 'source_content.source_id'
  content: one(sourceContent, {
    fields: [sources.id],
    references: [sourceContent.sourceId],
  }),
  chunks: many(chunks),
  citations: many(citations),
  claimEvidence: many(claimEvidence),
}));

export const sourceContentRelations = relations(sourceContent, ({ one }) => ({
  source: one(sources, {
    fields: [sourceContent.sourceId],
    references: [sources.id],
  }),
}));

export const chunksRelations = relations(chunks, ({ one, many }) => ({
  source: one(sources, {
    fields: [chunks.sourceId],
    references: [sources.id],
  }),
  citations: many(citations),
  claimEvidence: many(claimEvidence),
}));

export const claimsRelations = relations(claims, ({ one, many }) => ({
  message: one(messages, {
    fields: [claims.messageId],
    references: [messages.id],
  }),
  evidence: many(claimEvidence),
}));

export const citationsRelations = relations(citations, ({ one }) => ({
  message: one(messages, {
    fields: [citations.messageId],
    references: [messages.id],
  }),
  source: one(sources, {
    fields: [citations.sourceId],
    references: [sources.id],
  }),
  chunk: one(chunks, {
    fields: [citations.chunkId],
    references: [chunks.id],
  }),
}));

export const claimEvidenceRelations = relations(claimEvidence, ({ one }) => ({
  claim: one(claims, {
    fields: [claimEvidence.claimId],
    references: [claims.id],
  }),
  source: one(sources, {
    fields: [claimEvidence.sourceId],
    references: [sources.id],
  }),
  chunk: one(chunks, {
    fields: [claimEvidence.chunkId],
    references: [chunks.id],
  }),
}));

export const searchEventsRelations = relations(searchEvents, ({ one }) => ({
  thread: one(threads, {
    fields: [searchEvents.threadId],
    references: [threads.id],
  }),
}));