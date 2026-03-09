import { z } from "zod";

export const chatStreamInputSchema = z.object({
  tenant_id: z.string().trim().min(2).max(80),
  device_id: z.string().trim().min(2).max(120),
  chat_id: z.string().uuid().optional(),
  message: z.string().trim().min(1).max(4000),
  page_context: z
    .object({
      url: z.string().url().optional(),
      title: z.string().max(280).optional(),
      content: z.string().max(5000).optional()
    })
    .optional()
});

export const createChatSchema = z.object({
  tenant_id: z.string().trim().min(2).max(80),
  device_id: z.string().trim().min(2).max(120),
  title: z.string().trim().min(1).max(160).optional()
});

export const patchChatSchema = z.object({
  tenant_id: z.string().trim().min(2).max(80),
  device_id: z.string().trim().min(2).max(120),
  title: z.string().trim().min(1).max(160)
});

export const chatQuerySchema = z.object({
  tenant_id: z.string().trim().min(2).max(80),
  device_id: z.string().trim().min(2).max(120)
});

// Backward-compatible names used by API routes
export const chatsQuerySchema = chatQuerySchema;
export const messagesQuerySchema = chatQuerySchema;
export const deleteChatQuerySchema = chatQuerySchema;
export const createChatInputSchema = createChatSchema;
export const patchChatInputSchema = patchChatSchema;
