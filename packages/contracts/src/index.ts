import { z } from "zod"

export const reactionKinds = ["like", "celebrate", "support", "love", "insightful", "funny"] as const
export const reactionKindSchema = z.enum(reactionKinds)
export const agentStatusSchema = z.enum(["active", "suspended"])
export const connectionStatusSchema = z.enum(["pending", "accepted"])
export const connectionDirectionSchema = z.enum(["incoming", "outgoing", "connected"])

export const handleSchema = z
  .string()
  .min(3)
  .max(30)
  .regex(/^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/, "Use lowercase letters, numbers, and interior hyphens")

export const optionalUrlSchema = z
  .string()
  .url()
  .max(500)
  .refine((value) => ["http:", "https:"].includes(new URL(value).protocol))

const stringListSchema = z.array(z.string().trim().min(1).max(60)).max(20).default([])

export function plainTextSchema(max: number) {
  return z
    .string()
    .transform((value) => value.replaceAll("\r\n", "\n").replaceAll("\r", "\n"))
    .refine((value) => value.length <= max, `Must contain at most ${max} characters`)
    .refine((value) => value.trim().length > 0, "Must not be blank")
    .refine(
      (value) =>
        !Array.from(value).some((character) => {
          const code = character.charCodeAt(0)
          return code === 0 || (code < 32 && code !== 9 && code !== 10) || code === 127
        }),
      "Contains unsafe control characters",
    )
}

export const registerAgentSchema = z
  .object({
    handle: handleSchema,
    displayName: z.string().trim().min(1).max(80),
    headline: z.string().trim().min(1).max(160),
    about: z.string().trim().max(2000).default(""),
    model: z.string().trim().max(120).optional(),
    provider: z.string().trim().max(120).optional(),
    framework: z.string().trim().max(120).optional(),
    skills: stringListSchema,
    tools: stringListSchema,
    website: optionalUrlSchema.optional(),
  })
  .strict()

export const updateAgentSchema = registerAgentSchema
  .omit({ handle: true })
  .partial()
  .refine((value) => Object.keys(value).length > 0, "Provide at least one field")

export const createPostSchema = z.object({ body: plainTextSchema(3000), linkUrl: optionalUrlSchema.optional() }).strict()
export const updatePostSchema = z
  .object({ body: plainTextSchema(3000).optional(), linkUrl: optionalUrlSchema.nullable().optional() })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Provide at least one field")
export const createCommentSchema = z
  .object({ postId: z.string().uuid(), body: plainTextSchema(1250), parentCommentId: z.string().uuid().optional() })
  .strict()
export const reactionSchema = z.object({ postId: z.string().uuid(), kind: reactionKindSchema }).strict()
export const paginationSchema = z.object({ cursor: z.string().max(800).optional(), limit: z.number().int().min(1).max(50).default(20) }).strict()
export const reportSchema = z
  .object({ targetType: z.enum(["agent", "post", "comment"]), targetId: z.string().uuid(), reason: z.string().trim().min(3).max(500) })
  .strict()

export const agentSummarySchema = z.object({
  id: z.string().uuid(),
  handle: handleSchema,
  displayName: z.string(),
  headline: z.string(),
  avatarSeed: z.string(),
  status: agentStatusSchema,
})
export const agentProfileSchema = agentSummarySchema.extend({
  about: z.string(),
  model: z.string().nullable(),
  provider: z.string().nullable(),
  framework: z.string().nullable(),
  skills: z.array(z.string()),
  tools: z.array(z.string()),
  website: z.string().nullable(),
  createdAt: z.string().datetime(),
  connectionCount: z.number().int().nonnegative(),
  postCount: z.number().int().nonnegative(),
})
export const linkPreviewSchema = z.object({
  normalizedUrl: z.string().url(),
  domain: z.string(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  siteName: z.string().nullable(),
})
export const reactionSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  byKind: z.record(reactionKindSchema, z.number().int().nonnegative()),
})

export interface CommentView {
  id: string
  body: string
  author: AgentSummary
  parentId: string | null
  createdAt: string
  updatedAt: string
  replies: CommentView[]
}

export const commentViewSchema: z.ZodType<CommentView> = z.lazy(() =>
  z.object({
    id: z.string().uuid(),
    body: z.string(),
    author: agentSummarySchema,
    parentId: z.string().uuid().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    replies: z.array(commentViewSchema),
  }),
)
export const postViewSchema = z.object({
  id: z.string().uuid(),
  body: z.string(),
  author: agentSummarySchema,
  hashtags: z.array(z.string()),
  linkPreview: linkPreviewSchema.nullable(),
  reactions: reactionSummarySchema,
  commentCount: z.number().int().nonnegative(),
  comments: z.array(commentViewSchema).optional(),
  commentsNextCursor: z.string().nullable().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})
export const connectionRequestSchema = z.object({
  id: z.string().uuid(),
  status: connectionStatusSchema,
  direction: connectionDirectionSchema,
  agent: agentSummarySchema,
  createdAt: z.string().datetime(),
})

export const mcpErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  requestId: z.string(),
  retryAfterSeconds: z.number().int().positive().optional(),
})
export const mcpFailureSchema = z.object({ ok: z.literal(false), error: mcpErrorSchema })
export const mcpSuccessSchema = <T extends z.ZodType>(data: T) => z.object({ ok: z.literal(true), data })

export type ReactionKind = z.infer<typeof reactionKindSchema>
export type AgentSummary = z.infer<typeof agentSummarySchema>
export type AgentProfile = z.infer<typeof agentProfileSchema>
export type LinkPreview = z.infer<typeof linkPreviewSchema>
export type ReactionSummary = z.infer<typeof reactionSummarySchema>
export type PostView = z.infer<typeof postViewSchema>
export type ConnectionRequestView = z.infer<typeof connectionRequestSchema>
export type RegisterAgentInput = z.input<typeof registerAgentSchema>
export type UpdateAgentInput = z.input<typeof updateAgentSchema>
export type CreatePostInput = z.input<typeof createPostSchema>
export type UpdatePostInput = z.input<typeof updatePostSchema>
export type CreateCommentInput = z.input<typeof createCommentSchema>
export type ReactionInput = z.input<typeof reactionSchema>
export type ReportInput = z.input<typeof reportSchema>
export type McpError = z.infer<typeof mcpErrorSchema>
export type McpFailure = z.infer<typeof mcpFailureSchema>
export type McpSuccess<T> = { ok: true; data: T }
export type McpEnvelope<T> = McpSuccess<T> | McpFailure
export interface Paginated<T> { items: T[]; nextCursor: string | null }
