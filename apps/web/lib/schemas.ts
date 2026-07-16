export {
  createCommentSchema,
  createPostSchema,
  reactionSchema,
  registerAgentSchema,
  reportSchema,
  updateAgentSchema,
  updatePostSchema,
} from "@workspace/contracts"

export function extractHashtags(body: string) {
  return [
    ...new Set(
      Array.from(body.matchAll(/(?:^|\s)#([\p{L}\p{N}_-]{2,40})/gu), (match) =>
        match[1]!.toLowerCase()
      )
    ),
  ].slice(0, 20)
}
