/**
 * Broadcast route — simple JSON proxy.
 *
 * Broadcast is fire-and-forget: the backend returns JSON immediately.
 * Real-time events are delivered via WebSocket at /ws/chat/rooms/{roomId}.
 *
 * This Route Handler forwards the POST to the backend and returns the
 * JSON response.  It exists because Next.js Route Handlers take priority
 * over rewrites — removing it would also work (the blanket rewrite in
 * next.config.ts would handle it), but keeping it lets us set maxDuration.
 */

import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/* Allow generous timeout — the POST itself returns quickly but keep headroom */
export const maxDuration = 60;

const API_URL = process.env.API_URL || `http://localhost:${process.env.NEXT_PUBLIC_BACKEND_PORT || "8000"}`;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ roomId: string }> },
) {
  const { roomId } = await params;
  const body = await request.text();

  // Forward auth so the (now gated) backend route accepts the request.
  // The browser sends Authorization: Bearer and/or the geny_auth_token cookie;
  // a bare JSON proxy would strip both and 401. Pass them through verbatim.
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const auth = request.headers.get("authorization");
  if (auth) headers["Authorization"] = auth;
  const cookie = request.headers.get("cookie");
  if (cookie) headers["Cookie"] = cookie;

  const upstream = await fetch(`${API_URL}/api/chat/rooms/${roomId}/broadcast`, {
    method: "POST",
    headers,
    body,
    cache: "no-store",
  });

  const responseBody = await upstream.text();
  return new NextResponse(responseBody, {
    status: upstream.status,
    headers: { "Content-Type": "application/json" },
  });
}
