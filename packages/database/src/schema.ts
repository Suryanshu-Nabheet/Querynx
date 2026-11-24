/**
 * Drizzle schema for Querynx persistent state.
 *
 * Tables:
 *  - documents      : the indexed corpus (native search)
 *  - chunks         : heading-aware passages for retrieval
 *  - api_keys       : hashed credentials
 *  - jobs           : durable background jobs (crawl/research/index)
 *  - usage_events   : per-request accounting for /v1/usage
 */

import {
  pgTable,
  text,
  timestamp,
  integer,
  jsonb,
  boolean,
  index,
  uniqueIndex,
  doublePrecision,
  uuid,
} from 'drizzle-orm/pg-core';

export const documents = pgTable(
  'documents',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    collection: text('collection').notNull(),
    url: text('url').notNull(),
    title: text('title').notNull(),
    content: text('content').notNull(),
    fingerprint: text('fingerprint').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    indexedAt: timestamp('indexed_at', { withTimezone: true }).notNull().defaultNow(),
    metadata: jsonb('metadata'),
  },
  (t) => [
    uniqueIndex('documents_url_unique').on(t.url),
    index('documents_collection_idx').on(t.collection),
    index('documents_fingerprint_idx').on(t.fingerprint),
  ]
);

export const chunks = pgTable(
  'chunks',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    sectionTitle: text('section_title'),
    content: text('content').notNull(),
    tokenEstimate: integer('token_estimate').notNull(),
    embedding: doublePrecision('embedding').array(),
  },
  (t) => [
    index('chunks_document_idx').on(t.documentId),
  ]
);

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    hash: text('hash').notNull(),
    label: text('label').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    rateLimitPerMinute: integer('rate_limit_per_minute'),
    revoked: boolean('revoked').notNull().default(false),
  },
  (t) => [uniqueIndex('api_keys_hash_unique').on(t.hash)]
);

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    type: text('type').notNull(), // crawl | research | index | reindex
    status: text('status').notNull().default('pending'), // pending|running|completed|failed|cancelled
    payload: jsonb('payload').notNull(),
    result: jsonb('result'),
    error: text('error'),
    priority: integer('priority').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    index('jobs_status_idx').on(t.status),
    index('jobs_type_idx').on(t.type),
  ]
);

export const usageEvents = pgTable(
  'usage_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    apiKeyHash: text('api_key_hash'),
    route: text('route').notNull(),
    statusCode: integer('status_code').notNull(),
    durationMs: integer('duration_ms').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('usage_route_idx').on(t.route), index('usage_created_idx').on(t.createdAt)]
);
