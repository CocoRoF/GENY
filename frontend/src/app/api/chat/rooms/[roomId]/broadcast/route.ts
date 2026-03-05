/**
 * Streaming SSE proxy for chat room broadcast.
 *
 * Next.js `rewrites()` buffers the entire upstream response before forwarding it
 * to the browser, which means SSE events only arrive after the last agent finishes.
 *
 * This Route Handler bypasses that limitation by piping the backend's
 * ReadableStream directly to the client so each SSE event is delivered
 * as soon as the backend yields it.
 */

import { NextRequest } from "next/server";

const API_URL = process.env.API_URL || "http://localhost:8000";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ roomId: string }> },
) {
  const { roomId } = await params;
  const body = await request.text();

  const upstream = await fetch(`${API_URL}/api/chat/rooms/${roomId}/broadcast`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

  if (!upstream.ok) {
    const errorBody = await upstream.text();
    return new Response(errorBody, {
      status: upstream.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Pipe the upstream SSE stream directly — no buffering.
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
