import { createServer } from "http";
import next from "next";
import { Server } from "socket.io";

const DEFAULT_PORT = 3000;

function normalizeString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function getConversationRoom(conversationId) {
  return `conversation:${conversationId}`;
}

function normalizeTypingPayload(payload, socket) {
  const input = payload && typeof payload === "object" ? payload : {};
  const conversationId =
    normalizeString(input.conversationId) ||
    normalizeString(input.chat_id) ||
    normalizeString(input.chatId) ||
    normalizeString(input.conversation_id) ||
    normalizeString(socket.data.conversationId);
  const userId =
    normalizeString(input.userId) ||
    normalizeString(input.user_id) ||
    normalizeString(input.sender_id) ||
    normalizeString(socket.data.userId);
  const actor =
    input.actor === "agent" || input.actor === "visitor"
      ? input.actor
      : input.sender_type === "agent" || input.sender_type === "visitor"
        ? input.sender_type
        : socket.data.actor;

  if (!conversationId || !userId || (actor !== "agent" && actor !== "visitor")) {
    return null;
  }

  const userName =
    normalizeString(input.userName) ||
    normalizeString(input.user_name) ||
    normalizeString(input.senderName) ||
    normalizeString(socket.data.userName);

  return {
    chat_id: conversationId,
    chatId: conversationId,
    conversation_id: conversationId,
    conversationId,
    actor,
    sender_type: actor,
    user_id: userId,
    sender_id: userId,
    userId,
    userName: userName || undefined,
    user_name: userName || undefined,
    senderName: userName || undefined
  };
}

function rememberParticipant(socket, payload) {
  socket.data.conversationId = payload.conversationId;
  socket.data.userId = payload.userId;
  socket.data.actor = payload.actor;
  socket.data.userName = payload.userName;
}

function broadcastTyping(socket, eventName, payload) {
  const normalized = normalizeTypingPayload(payload, socket);
  if (!normalized) {
    return;
  }

  rememberParticipant(socket, normalized);
  const isTyping = eventName === "typing:start";
  const room = getConversationRoom(normalized.conversationId);
  const outgoing = {
    ...normalized,
    is_typing: isTyping,
    isTyping,
    typing: isTyping
  };

  socket.join(room);
  socket.to(room).emit(eventName, outgoing);
  socket.to(room).emit("typing", outgoing);
}

function attachSocketServer(httpServer) {
  const io = new Server(httpServer, {
    path: "/socket.io",
    cors: {
      origin: true,
      credentials: true,
      methods: ["GET", "POST"]
    }
  });

  io.on("connection", (socket) => {
    socket.on("conversation:join", (payload) => {
      const normalized = normalizeTypingPayload(payload, socket);
      if (!normalized) {
        return;
      }

      rememberParticipant(socket, normalized);
      socket.join(getConversationRoom(normalized.conversationId));
    });

    socket.on("conversation:leave", (payload) => {
      const normalized = normalizeTypingPayload(payload, socket);
      if (!normalized) {
        return;
      }

      broadcastTyping(socket, "typing:stop", normalized);
      socket.leave(getConversationRoom(normalized.conversationId));
      socket.data.conversationId = undefined;
      socket.data.userId = undefined;
      socket.data.actor = undefined;
      socket.data.userName = undefined;
    });

    socket.on("typing:start", (payload) => {
      broadcastTyping(socket, "typing:start", payload);
    });

    socket.on("typing:stop", (payload) => {
      broadcastTyping(socket, "typing:stop", payload);
    });

    socket.on("disconnect", () => {
      const normalized = normalizeTypingPayload({}, socket);
      if (!normalized) {
        return;
      }
      const room = getConversationRoom(normalized.conversationId);
      const outgoing = {
        ...normalized,
        is_typing: false,
        isTyping: false,
        typing: false
      };
      socket.to(room).emit("typing:stop", outgoing);
      socket.to(room).emit("typing", outgoing);
    });
  });

  return io;
}

export async function startSocketServer({ projectRoot, dev, hostname = "localhost", port = DEFAULT_PORT }) {
  const app = next({ dev, dir: projectRoot, hostname, port });
  const handle = app.getRequestHandler();

  await app.prepare();

  const httpServer = createServer((request, response) => {
    handle(request, response);
  });

  attachSocketServer(httpServer);

  await new Promise((resolve) => {
    httpServer.listen(port, hostname, resolve);
  });

  console.log(`> Ready on http://${hostname}:${port}`);

  const close = () => {
    httpServer.close(() => {
      process.exit(0);
    });
  };

  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}
