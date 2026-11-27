"use client";

import { useHydrated } from "@/lib/client/use-hydrated";
import { formatDate, timeAgo } from "@/lib/utils";
import { formatUtcShortDate, relativeTime, timeOfDay } from "@/lib/deploy/format";

export function TimeAgoText({ iso }: { iso: string | null | undefined }) {
  const hydrated = useHydrated();
  return <>{hydrated ? timeAgo(iso) : formatDate(iso)}</>;
}

export function RelativeDeployTimeText({
  value,
  empty = "",
}: {
  value: string | number | null | undefined;
  empty?: string;
}) {
  const hydrated = useHydrated();
  if (!value) return <>{empty}</>;
  return <>{hydrated ? relativeTime(value) : formatUtcShortDate(value)}</>;
}

export function TimeOfDayText({ value }: { value: string | number | null | undefined }) {
  const hydrated = useHydrated();
  return <>{hydrated ? timeOfDay(value) : timeOfDay(value, "en-GB", "UTC")}</>;
}

export function LocalDateTimeText({
  value,
  fallback = "Just now",
}: {
  value: string | number | null | undefined;
  fallback?: string;
}) {
  const hydrated = useHydrated();
  if (!value) return <>{fallback}</>;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return <>{fallback}</>;
  if (!hydrated) {
    return <>{date.toLocaleDateString("en-GB", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" })}</>;
  }
  return <>{date.toLocaleString()}</>;
}

/**
 * "Last verified" reads as relative time once hydrated (e.g. "2 min ago",
 * "3 days ago"); the server renders a stable date to avoid a hydration mismatch.
 */
export function VerifiedTimeText({
  value,
  fallback = "Not tested yet",
}: {
  value: string | number | null | undefined;
  fallback?: string;
}) {
  const hydrated = useHydrated();
  if (!value) return <>{fallback}</>;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return <>{fallback}</>;
  if (!hydrated) {
    return <>{date.toLocaleDateString("en-GB", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" })}</>;
  }
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return <>just now</>;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return <>{minutes} min ago</>;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return <>{hours} hour{hours === 1 ? "" : "s"} ago</>;
  const days = Math.floor(hours / 24);
  if (days < 30) return <>{days} day{days === 1 ? "" : "s"} ago</>;
  return <>{date.toLocaleDateString()}</>;
}
