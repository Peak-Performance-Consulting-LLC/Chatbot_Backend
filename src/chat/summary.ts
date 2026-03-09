import type { ChatMessage } from "@/chat/types";

export async function maybeSummarizeConversation(messages: ChatMessage[]): Promise<string | null> {
  if (messages.length < 6) {
    return null;
  }

  const lastUser = [...messages].reverse().find((item) => item.role === "user")?.content;
  if (!lastUser) {
    return null;
  }

  return lastUser.length <= 160 ? lastUser : `${lastUser.slice(0, 160)}...`;
}
