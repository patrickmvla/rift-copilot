CREATE TABLE `chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`pos` integer NOT NULL,
	`char_start` integer NOT NULL,
	`char_end` integer NOT NULL,
	`text` text NOT NULL,
	`tokens` integer NOT NULL,
	`created_at` integer DEFAULT (strftime('%s','now')) NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_chunks_source_id` ON `chunks` (`source_id`);--> statement-breakpoint
CREATE INDEX `idx_chunks_source_pos` ON `chunks` (`source_id`,`pos`);--> statement-breakpoint
CREATE TABLE `citations` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`source_id` text NOT NULL,
	`chunk_id` text,
	`quote` text NOT NULL,
	`char_start` integer,
	`char_end` integer,
	`rank_score` real,
	`created_at` integer DEFAULT (strftime('%s','now')) NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`chunk_id`) REFERENCES `chunks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_citations_message_id` ON `citations` (`message_id`);--> statement-breakpoint
CREATE INDEX `idx_citations_source_id` ON `citations` (`source_id`);--> statement-breakpoint
CREATE INDEX `idx_citations_chunk_id` ON `citations` (`chunk_id`);--> statement-breakpoint
CREATE TABLE `claim_evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`claim_id` text NOT NULL,
	`source_id` text NOT NULL,
	`chunk_id` text NOT NULL,
	`quote` text NOT NULL,
	`char_start` integer NOT NULL,
	`char_end` integer NOT NULL,
	`score` real,
	FOREIGN KEY (`claim_id`) REFERENCES `claims`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`chunk_id`) REFERENCES `chunks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_claim_evidence_claim_id` ON `claim_evidence` (`claim_id`);--> statement-breakpoint
CREATE INDEX `idx_claim_evidence_source_id` ON `claim_evidence` (`source_id`);--> statement-breakpoint
CREATE INDEX `idx_claim_evidence_chunk_id` ON `claim_evidence` (`chunk_id`);--> statement-breakpoint
CREATE TABLE `claims` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`text` text NOT NULL,
	`claim_type` text,
	`support_score` real NOT NULL,
	`contradicted` integer DEFAULT false NOT NULL,
	`uncertainty_reason` text,
	`created_at` integer DEFAULT (strftime('%s','now')) NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_claims_message_id` ON `claims` (`message_id`);--> statement-breakpoint
CREATE TABLE `ingest_queue` (
	`id` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`error` text,
	`created_at` integer DEFAULT (strftime('%s','now')) NOT NULL,
	`updated_at` integer DEFAULT (strftime('%s','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_ingest_queue_status` ON `ingest_queue` (`status`);--> statement-breakpoint
CREATE INDEX `idx_ingest_queue_url` ON `ingest_queue` (`url`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`role` text NOT NULL,
	`content_md` text NOT NULL,
	`created_at` integer DEFAULT (strftime('%s','now')) NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_messages_thread_id` ON `messages` (`thread_id`);--> statement-breakpoint
CREATE INDEX `idx_messages_created_at` ON `messages` (`created_at`);--> statement-breakpoint
CREATE TABLE `search_events` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text,
	`query` text NOT NULL,
	`results_json` text NOT NULL,
	`created_at` integer DEFAULT (strftime('%s','now')) NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_search_events_thread_id` ON `search_events` (`thread_id`);--> statement-breakpoint
CREATE INDEX `idx_search_events_created_at` ON `search_events` (`created_at`);--> statement-breakpoint
CREATE TABLE `source_content` (
	`source_id` text PRIMARY KEY NOT NULL,
	`text` text NOT NULL,
	`html` text,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_source_content_source_id` ON `source_content` (`source_id`);--> statement-breakpoint
CREATE TABLE `sources` (
	`id` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`domain` text NOT NULL,
	`title` text,
	`published_at` text,
	`crawled_at` text,
	`lang` text,
	`fingerprint` text,
	`word_count` integer,
	`status` text,
	`http_status` integer,
	`created_at` integer DEFAULT (strftime('%s','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sources_url_unique` ON `sources` (`url`);--> statement-breakpoint
CREATE UNIQUE INDEX `sources_fingerprint_unique` ON `sources` (`fingerprint`);--> statement-breakpoint
CREATE INDEX `idx_sources_domain` ON `sources` (`domain`);--> statement-breakpoint
CREATE INDEX `idx_sources_created_at` ON `sources` (`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_sources_url` ON `sources` (`url`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_sources_fingerprint` ON `sources` (`fingerprint`);--> statement-breakpoint
CREATE TABLE `threads` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`visitor_id` text,
	`created_at` integer DEFAULT (strftime('%s','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_threads_created_at` ON `threads` (`created_at`);