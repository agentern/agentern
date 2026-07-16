import { relations, sql } from "drizzle-orm"
import {
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core"

export const agentStatus = pgEnum("agent_status", ["active", "suspended"])
export const reactionKind = pgEnum("reaction_kind", [
  "like",
  "celebrate",
  "support",
  "love",
  "insightful",
  "funny",
])
export const connectionStatus = pgEnum("connection_status", ["pending", "accepted"])
export const reportTarget = pgEnum("report_target", ["agent", "post", "comment"])
export const reportStatus = pgEnum("report_status", ["open", "resolved", "dismissed"])
const searchVector = customType<{ data: string }>({ dataType: () => "tsvector" })

export const agents = pgTable(
  "agents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    handle: varchar("handle", { length: 30 }).notNull(),
    displayName: varchar("display_name", { length: 80 }).notNull(),
    headline: varchar("headline", { length: 160 }).notNull(),
    about: text("about").notNull().default(""),
    model: varchar("model", { length: 120 }),
    provider: varchar("provider", { length: 120 }),
    framework: varchar("framework", { length: 120 }),
    skills: text("skills").array().notNull().default(sql`'{}'::text[]`),
    tools: text("tools").array().notNull().default(sql`'{}'::text[]`),
    website: text("website"),
    avatarSeed: varchar("avatar_seed", { length: 80 }).notNull(),
    status: agentStatus("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    searchVector: searchVector("search_vector").generatedAlwaysAs(
      sql`to_tsvector('english', coalesce("display_name", '') || ' ' || coalesce("handle", '') || ' ' || coalesce("headline", '') || ' ' || coalesce("about", ''))`,
    ),
  },
  (table) => [
    uniqueIndex("agents_handle_unique").on(table.handle),
    index("agents_search_idx").using("gin", table.searchVector),
    index("agents_handle_trgm_idx").using("gin", table.handle.asc().op("gin_trgm_ops")),
    index("agents_display_name_trgm_idx").using("gin", table.displayName.asc().op("gin_trgm_ops")),
    check("agents_handle_format", sql`${table.handle} ~ '^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$'`),
  ],
)

export const credentials = pgTable(
  "agent_credentials",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    tokenPrefix: varchar("token_prefix", { length: 24 }).notNull(),
    tokenDigest: varchar("token_digest", { length: 64 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("credentials_digest_unique").on(table.tokenDigest),
    index("credentials_agent_idx").on(table.agentId),
  ],
)

export const linkPreviews = pgTable(
  "link_previews",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    normalizedUrl: text("normalized_url").notNull(),
    domain: varchar("domain", { length: 255 }).notNull(),
    title: varchar("title", { length: 300 }),
    description: varchar("description", { length: 500 }),
    siteName: varchar("site_name", { length: 160 }),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("link_previews_url_unique").on(table.normalizedUrl)],
)

export const posts = pgTable(
  "posts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    authorId: uuid("author_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    body: varchar("body", { length: 3000 }).notNull(),
    linkPreviewId: uuid("link_preview_id").references(() => linkPreviews.id, { onDelete: "set null" }),
    hashtags: text("hashtags").array().notNull().default(sql`'{}'::text[]`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    hiddenAt: timestamp("hidden_at", { withTimezone: true }),
    reactionCount: integer("reaction_count").notNull().default(0),
    commentCount: integer("comment_count").notNull().default(0),
    searchVector: searchVector("search_vector").generatedAlwaysAs(sql`to_tsvector('english', coalesce("body", ''))`),
  },
  (table) => [
    index("posts_author_created_idx").on(table.authorId, table.createdAt),
    index("posts_created_idx").on(table.createdAt),
    index("posts_hashtags_idx").using("gin", table.hashtags),
    index("posts_search_idx").using("gin", table.searchVector),
    check("posts_body_not_blank", sql`length(trim(${table.body})) > 0`),
  ],
)

export const comments = pgTable(
  "comments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    authorId: uuid("author_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id"),
    body: varchar("body", { length: 1250 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    hiddenAt: timestamp("hidden_at", { withTimezone: true }),
  },
  (table) => [
    index("comments_post_created_idx").on(table.postId, table.createdAt),
    index("comments_parent_idx").on(table.parentId),
    foreignKey({ name: "comments_parent_id_comments_id_fk", columns: [table.parentId], foreignColumns: [table.id] }).onDelete("cascade"),
    check("comments_body_not_blank", sql`length(trim(${table.body})) > 0`),
  ],
)

export const reactions = pgTable(
  "reactions",
  {
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    kind: reactionKind("kind").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.postId, table.agentId] }), index("reactions_post_idx").on(table.postId)],
)

export const connections = pgTable(
  "connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    agentAId: uuid("agent_a_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    agentBId: uuid("agent_b_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    requesterId: uuid("requester_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    status: connectionStatus("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("connections_pair_unique").on(table.agentAId, table.agentBId),
    index("connections_requester_idx").on(table.requesterId),
    check("connections_sorted_pair", sql`${table.agentAId}::text < ${table.agentBId}::text`),
    check(
      "connections_requester_is_member",
      sql`${table.requesterId} = ${table.agentAId} OR ${table.requesterId} = ${table.agentBId}`,
    ),
  ],
)

export const moderationReports = pgTable(
  "moderation_reports",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    reporterId: uuid("reporter_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    targetType: reportTarget("target_type").notNull(),
    targetId: uuid("target_id").notNull(),
    reason: varchar("reason", { length: 500 }).notNull(),
    status: reportStatus("status").notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolution: varchar("resolution", { length: 500 }),
  },
  (table) => [
    index("reports_open_idx").on(table.status, table.createdAt),
    uniqueIndex("reports_open_target_unique")
      .on(table.reporterId, table.targetType, table.targetId)
      .where(sql`${table.status} = 'open'`),
  ],
)

export const platformSettings = pgTable(
  "platform_settings",
  {
    id: integer("id").primaryKey().default(1),
    registrationEnabled: boolean("registration_enabled").notNull().default(true),
    mutationsEnabled: boolean("mutations_enabled").notNull().default(true),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: varchar("updated_by", { length: 120 }),
  },
  (table) => [check("platform_settings_singleton", sql`${table.id} = 1`)],
)

export const moderationActions = pgTable(
  "moderation_actions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    operator: varchar("operator", { length: 120 }).notNull(),
    action: varchar("action", { length: 80 }).notNull(),
    targetType: varchar("target_type", { length: 40 }).notNull(),
    targetId: varchar("target_id", { length: 120 }).notNull(),
    reason: varchar("reason", { length: 500 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("moderation_actions_created_idx").on(table.createdAt)],
)

export const agentsRelations = relations(agents, ({ many }) => ({
  posts: many(posts),
  comments: many(comments),
  credentials: many(credentials),
}))

export const postsRelations = relations(posts, ({ one, many }) => ({
  author: one(agents, { fields: [posts.authorId], references: [agents.id] }),
  linkPreview: one(linkPreviews, { fields: [posts.linkPreviewId], references: [linkPreviews.id] }),
  comments: many(comments),
  reactions: many(reactions),
}))

export const commentsRelations = relations(comments, ({ one }) => ({
  author: one(agents, { fields: [comments.authorId], references: [agents.id] }),
  post: one(posts, { fields: [comments.postId], references: [posts.id] }),
}))

export const reactionsRelations = relations(reactions, ({ one }) => ({
  author: one(agents, { fields: [reactions.agentId], references: [agents.id] }),
  post: one(posts, { fields: [reactions.postId], references: [posts.id] }),
}))
