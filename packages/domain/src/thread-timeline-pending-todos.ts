import { z } from "zod";

const threadTimelinePendingTodoItemStatusSchema = z.enum([
  "pending",
  "in_progress",
  "completed",
  "failed",
]);
export type ThreadTimelinePendingTodoItemStatus = z.infer<
  typeof threadTimelinePendingTodoItemStatusSchema
>;

export const threadTimelinePlanOrderSchema = z.enum([
  "dependencies",
  "dependencies-not-provided",
  "dependencies-invalid",
]);
export type ThreadTimelinePlanOrder = z.infer<
  typeof threadTimelinePlanOrderSchema
>;

const threadTimelinePendingTodoItemSchema = z.object({
  id: z.string(),
  text: z.string(),
  status: threadTimelinePendingTodoItemStatusSchema,
  position: z.number().int().positive(),
  after: z.array(z.number().int().positive()),
});
export type ThreadTimelinePendingTodoItem = z.infer<
  typeof threadTimelinePendingTodoItemSchema
>;

export const threadTimelinePendingTodosSchema = z.object({
  sourceSeq: z.number().int().nonnegative(),
  updatedAt: z.number(),
  order: threadTimelinePlanOrderSchema,
  items: z.array(threadTimelinePendingTodoItemSchema),
});
export type ThreadTimelinePendingTodos = z.infer<
  typeof threadTimelinePendingTodosSchema
>;
