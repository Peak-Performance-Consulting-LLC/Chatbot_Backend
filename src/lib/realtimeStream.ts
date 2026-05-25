import { getBaseCorsHeaders } from "@/lib/cors";
import { subscribeRealtimeChannel } from "@/services/realtimeHub";

function encodeSSE(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function createRealtimeEventStream(request: Request, channelName: string) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let unsubscribe: (() => void) | null = null;

      function send(event: string, data: unknown) {
        if (closed) {
          return;
        }
        controller.enqueue(encoder.encode(encodeSSE(event, data)));
      }

      function close() {
        if (closed) {
          return;
        }
        closed = true;
        if (heartbeat) {
          clearInterval(heartbeat);
          heartbeat = null;
        }
        if (unsubscribe) {
          unsubscribe();
          unsubscribe = null;
        }
        try {
          controller.close();
        } catch {
          // The client may already have closed the stream.
        }
      }

      unsubscribe = subscribeRealtimeChannel(channelName, ({ event, payload }) => {
        send(event, payload);
      });
      heartbeat = setInterval(() => send("ping", { ts: Date.now() }), 25_000);

      request.signal.addEventListener("abort", close, { once: true });
      send("ready", { channel: channelName, ts: Date.now() });
    },
    cancel() {
      request.signal.dispatchEvent(new Event("abort"));
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
