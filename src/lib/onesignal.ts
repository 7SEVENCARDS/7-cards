// ─────────────────────────────────────────────────────────────────────────────
// OneSignal Push Notification Client
// Docs:  https://documentation.onesignal.com/reference/create-notification
// Setup: https://app.onesignal.com → Your App → Keys & IDs
//
// Client-side requirement:
//   After a user logs in, call:
//     OneSignal.login(supabaseUserId)   // sets external_id
//   This links their device to their Supabase user ID so server-side pushes work.
// ─────────────────────────────────────────────────────────────────────────────

import { fetchWithTimeout } from "./fetch-with-timeout";

const ONESIGNAL_API = "https://onesignal.com/api/v1";

function getOneSignalHeaders() {
  const restKey = process.env.ONESIGNAL_REST_API_KEY;
  if (!restKey || restKey.includes("YOUR_")) {
    throw new Error("[OneSignal] ONESIGNAL_REST_API_KEY not configured");
  }
  return {
    Authorization: `Basic ${restKey}`,
    "Content-Type": "application/json",
  };
}

function getAppId(): string {
  const appId = process.env.ONESIGNAL_APP_ID;
  if (!appId || appId.includes("YOUR_")) {
    throw new Error("[OneSignal] ONESIGNAL_APP_ID not configured");
  }
  return appId;
}

export type PushPayload = {
  title: string;
  message: string;
  data?: Record<string, string | number | boolean>;
  url?: string;
};

// ─── Send push to a specific user (by Supabase user ID) ──────────────────────
// Requires client-side: OneSignal.login(userId) after Supabase sign-in
export async function sendPushToUser(
  userId: string,
  payload: PushPayload
): Promise<{ success: boolean; id?: string; errors?: string[] }> {
  try {
    const res = await fetchWithTimeout(`${ONESIGNAL_API}/notifications`, {
      method: "POST",
      headers: getOneSignalHeaders(),
      body: JSON.stringify({
        app_id: getAppId(),
        target_channel: "push",
        include_aliases: { external_id: [userId] },
        headings: { en: payload.title },
        contents: { en: payload.message },
        data: payload.data ?? {},
        ...(payload.url ? { url: payload.url } : {}),
        // Android specific
        android_channel_id: process.env.ONESIGNAL_ANDROID_CHANNEL_ID,
        // iOS specific — show badge count
        ios_badgeType: "Increase",
        ios_badgeCount: 1,
      }),
    });

    const json = await res.json() as { id?: string; errors?: string[] };

    if (!res.ok || json.errors?.length) {
      console.warn("[OneSignal] Push delivery issue:", json.errors);
      return { success: false, errors: json.errors };
    }

    return { success: true, id: json.id };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes("not configured")) {
      console.error("[OneSignal] sendPushToUser error:", msg);
    }
    return { success: false, errors: [msg] };
  }
}

// ─── Send push to multiple users ─────────────────────────────────────────────
export async function sendPushToUsers(
  userIds: string[],
  payload: PushPayload
): Promise<{ success: boolean }> {
  try {
    const res = await fetchWithTimeout(`${ONESIGNAL_API}/notifications`, {
      method: "POST",
      headers: getOneSignalHeaders(),
      body: JSON.stringify({
        app_id: getAppId(),
        target_channel: "push",
        include_aliases: { external_id: userIds },
        headings: { en: payload.title },
        contents: { en: payload.message },
        data: payload.data ?? {},
      }),
    });
    return { success: res.ok };
  } catch {
    return { success: false };
  }
}

// ─── Broadcast to all subscribers ────────────────────────────────────────────
export async function broadcastPush(
  payload: PushPayload
): Promise<{ success: boolean }> {
  try {
    const res = await fetchWithTimeout(`${ONESIGNAL_API}/notifications`, {
      method: "POST",
      headers: getOneSignalHeaders(),
      body: JSON.stringify({
        app_id: getAppId(),
        target_channel: "push",
        included_segments: ["All"],
        headings: { en: payload.title },
        contents: { en: payload.message },
        data: payload.data ?? {},
      }),
    });
    return { success: res.ok };
  } catch {
    return { success: false };
  }
}

// ─── Helper: notify (DB insert handled by caller + push here) ─────────────────
// Call after inserting to the notifications table to also deliver a push.
export async function pushNotify(
  userId: string,
  title: string,
  message: string,
  data?: Record<string, string | number | boolean>
) {
  // Fire-and-forget — never let push failure block the main flow
  sendPushToUser(userId, { title, message, data }).catch(() => {/* silent */});
}
