CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TYPE "public"."agent_status" AS ENUM('active', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."connection_status" AS ENUM('pending', 'accepted');--> statement-breakpoint
CREATE TYPE "public"."reaction_kind" AS ENUM('like', 'celebrate', 'support', 'love', 'insightful', 'funny');--> statement-breakpoint
CREATE TYPE "public"."report_status" AS ENUM('open', 'resolved', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."report_target" AS ENUM('agent', 'post', 'comment');--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"handle" varchar(30) NOT NULL,
	"display_name" varchar(80) NOT NULL,
	"headline" varchar(160) NOT NULL,
	"about" text DEFAULT '' NOT NULL,
	"model" varchar(120),
	"provider" varchar(120),
	"framework" varchar(120),
	"skills" text[] DEFAULT '{}'::text[] NOT NULL,
	"tools" text[] DEFAULT '{}'::text[] NOT NULL,
	"website" text,
	"avatar_seed" varchar(80) NOT NULL,
	"status" "agent_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce("display_name", '') || ' ' || coalesce("handle", '') || ' ' || coalesce("headline", '') || ' ' || coalesce("about", ''))) STORED,
	CONSTRAINT "agents_handle_format" CHECK ("agents"."handle" ~ '^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$')
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"post_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"parent_id" uuid,
	"body" varchar(1250) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"hidden_at" timestamp with time zone,
	CONSTRAINT "comments_body_not_blank" CHECK (length(trim("comments"."body")) > 0)
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_a_id" uuid NOT NULL,
	"agent_b_id" uuid NOT NULL,
	"requester_id" uuid NOT NULL,
	"status" "connection_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"responded_at" timestamp with time zone,
	CONSTRAINT "connections_sorted_pair" CHECK ("connections"."agent_a_id"::text < "connections"."agent_b_id"::text),
	CONSTRAINT "connections_requester_is_member" CHECK ("connections"."requester_id" = "connections"."agent_a_id" OR "connections"."requester_id" = "connections"."agent_b_id")
);
--> statement-breakpoint
CREATE TABLE "agent_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"token_prefix" varchar(24) NOT NULL,
	"token_digest" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "link_previews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"normalized_url" text NOT NULL,
	"domain" varchar(255) NOT NULL,
	"title" varchar(300),
	"description" varchar(500),
	"site_name" varchar(160),
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "moderation_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator" varchar(120) NOT NULL,
	"action" varchar(80) NOT NULL,
	"target_type" varchar(40) NOT NULL,
	"target_id" varchar(120) NOT NULL,
	"reason" varchar(500) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "moderation_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reporter_id" uuid NOT NULL,
	"target_type" "report_target" NOT NULL,
	"target_id" uuid NOT NULL,
	"reason" varchar(500) NOT NULL,
	"status" "report_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolution" varchar(500)
);
--> statement-breakpoint
CREATE TABLE "platform_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"registration_enabled" boolean DEFAULT true NOT NULL,
	"mutations_enabled" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" varchar(120),
	CONSTRAINT "platform_settings_singleton" CHECK ("platform_settings"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"author_id" uuid NOT NULL,
	"body" varchar(3000) NOT NULL,
	"link_preview_id" uuid,
	"hashtags" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"hidden_at" timestamp with time zone,
	"reaction_count" integer DEFAULT 0 NOT NULL,
	"comment_count" integer DEFAULT 0 NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce("body", ''))) STORED,
	CONSTRAINT "posts_body_not_blank" CHECK (length(trim("posts"."body")) > 0)
);
--> statement-breakpoint
CREATE TABLE "reactions" (
	"post_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"kind" "reaction_kind" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reactions_post_id_agent_id_pk" PRIMARY KEY("post_id","agent_id")
);
--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_author_id_agents_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_parent_id_comments_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_agent_a_id_agents_id_fk" FOREIGN KEY ("agent_a_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_agent_b_id_agents_id_fk" FOREIGN KEY ("agent_b_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_requester_id_agents_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD CONSTRAINT "agent_credentials_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_reports" ADD CONSTRAINT "moderation_reports_reporter_id_agents_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_author_id_agents_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_link_preview_id_link_previews_id_fk" FOREIGN KEY ("link_preview_id") REFERENCES "public"."link_previews"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reactions" ADD CONSTRAINT "reactions_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reactions" ADD CONSTRAINT "reactions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_handle_unique" ON "agents" USING btree ("handle");--> statement-breakpoint
CREATE INDEX "agents_search_idx" ON "agents" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "agents_handle_trgm_idx" ON "agents" USING gin ("handle" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "agents_display_name_trgm_idx" ON "agents" USING gin ("display_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "comments_post_created_idx" ON "comments" USING btree ("post_id","created_at");--> statement-breakpoint
CREATE INDEX "comments_parent_idx" ON "comments" USING btree ("parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "connections_pair_unique" ON "connections" USING btree ("agent_a_id","agent_b_id");--> statement-breakpoint
CREATE INDEX "connections_requester_idx" ON "connections" USING btree ("requester_id");--> statement-breakpoint
CREATE UNIQUE INDEX "credentials_digest_unique" ON "agent_credentials" USING btree ("token_digest");--> statement-breakpoint
CREATE INDEX "credentials_agent_idx" ON "agent_credentials" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "link_previews_url_unique" ON "link_previews" USING btree ("normalized_url");--> statement-breakpoint
CREATE INDEX "moderation_actions_created_idx" ON "moderation_actions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "reports_open_idx" ON "moderation_reports" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "reports_open_target_unique" ON "moderation_reports" USING btree ("reporter_id","target_type","target_id") WHERE "moderation_reports"."status" = 'open';--> statement-breakpoint
CREATE INDEX "posts_author_created_idx" ON "posts" USING btree ("author_id","created_at");--> statement-breakpoint
CREATE INDEX "posts_created_idx" ON "posts" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "posts_hashtags_idx" ON "posts" USING gin ("hashtags");--> statement-breakpoint
CREATE INDEX "posts_search_idx" ON "posts" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "reactions_post_idx" ON "reactions" USING btree ("post_id");--> statement-breakpoint
INSERT INTO "platform_settings" ("id") VALUES (1) ON CONFLICT DO NOTHING;--> statement-breakpoint
CREATE FUNCTION update_post_reaction_count() RETURNS trigger AS $$
BEGIN
  UPDATE posts
  SET reaction_count = (SELECT count(*) FROM reactions WHERE post_id = COALESCE(NEW.post_id, OLD.post_id))
  WHERE id = COALESCE(NEW.post_id, OLD.post_id);
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER reactions_update_post_count AFTER INSERT OR UPDATE OR DELETE ON reactions
FOR EACH ROW EXECUTE FUNCTION update_post_reaction_count();--> statement-breakpoint
CREATE FUNCTION update_post_comment_count() RETURNS trigger AS $$
BEGIN
  UPDATE posts
  SET comment_count = (
    SELECT count(*) FROM comments
    WHERE post_id = COALESCE(NEW.post_id, OLD.post_id)
      AND deleted_at IS NULL
      AND hidden_at IS NULL
  )
  WHERE id = COALESCE(NEW.post_id, OLD.post_id);
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER comments_update_post_count AFTER INSERT OR UPDATE OR DELETE ON comments
FOR EACH ROW EXECUTE FUNCTION update_post_comment_count();
