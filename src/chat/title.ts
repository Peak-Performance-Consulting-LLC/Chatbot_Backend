export function buildChatTitleFromMessage(message: string): string {
  const cleaned = message.trim().replace(/\s+/g, " ");
  if (!cleaned) {
    return "New chat";
  }

  return cleaned.length <= 40 ? cleaned : `${cleaned.slice(0, 40)}...`;
}
