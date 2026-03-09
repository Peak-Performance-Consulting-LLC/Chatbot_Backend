import { getBaseCorsHeaders } from "@/lib/cors";

function encodeSSE(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function streamTextInChunks(text: string, send: (token: string) => void) {
  const tokens = text.split(/(\s+)/).filter(Boolean);
  for (const token of tokens) {
    send(token);
  }
}

export function createSSEStream(
  request: Request,
  handler: (writer: {
    token: (token: string) => void;
    done: (payload: Record<string, unknown>) => void;
    error: (message: string) => void;
  }) => Promise<void>
) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const writer = {
        token(token: string) {
          controller.enqueue(encoder.encode(encodeSSE("token", token)));
        },
        done(payload: Record<string, unknown>) {
          controller.enqueue(encoder.encode(encodeSSE("done", payload)));
        },
        error(message: string) {
          controller.enqueue(encoder.encode(encodeSSE("error", { message })));
        }
      };

      try {
        await handler(writer);
      } finally {
        controller.close();
      }
    }
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      ...getBaseCorsHeaders(request)
    }
  });
}
