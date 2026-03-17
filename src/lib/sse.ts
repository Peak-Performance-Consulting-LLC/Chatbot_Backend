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
      let closed = false;
      function enqueue(event: string, data: unknown) {
        if (closed) {
          return;
        }

        controller.enqueue(encoder.encode(encodeSSE(event, data)));
      }

      const writer = {
        token(token: string) {
          enqueue("token", token);
        },
        done(payload: Record<string, unknown>) {
          enqueue("done", payload);
        },
        error(message: string) {
          enqueue("error", { message });
        }
      };

      try {
        enqueue("ready", { ts: Date.now() });
        await handler(writer);
      } finally {
        closed = true;
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
