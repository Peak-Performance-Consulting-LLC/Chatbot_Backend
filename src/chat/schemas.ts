import { z } from "zod";

const visitorNameSchema = z
  .string()
  .trim()
  .min(2)
  .max(80)
  .regex(/^(?=.{2,80}$)[\p{L}][\p{L}\p{M}\s'.-]*$/u, "Enter a valid name");

const visitorPhoneSchema = z
  .string()
  .trim()
  .min(7)
  .max(32)
  .regex(/^[+\d\s().-]+$/, "Enter a valid phone number")
  .refine((value) => {
    const digits = value.replace(/\D/g, "").length;
    return digits >= 7 && digits <= 15;
  }, "Phone number must include 7 to 15 digits");

export const chatStreamInputSchema = z.object({
  tenant_id: z.string().trim().min(2).max(80),
  device_id: z.string().trim().min(2).max(120),
  chat_id: z.string().uuid().optional(),
  client_message_id: z.string().trim().min(8).max(120).optional(),
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

export const visitorContactInputSchema = z.object({
  tenant_id: z.string().trim().min(2).max(80),
  device_id: z.string().trim().min(2).max(120),
  chat_id: z.string().uuid().optional(),
  full_name: visitorNameSchema,
  email: z.string().trim().email().max(160),
  phone: visitorPhoneSchema
});

// Backward-compatible names used by API routes
export const chatsQuerySchema = chatQuerySchema;
export const messagesQuerySchema = chatQuerySchema;
export const deleteChatQuerySchema = chatQuerySchema;
export const createChatInputSchema = createChatSchema;
export const patchChatInputSchema = patchChatSchema;
