import { useEffect, useSyncExternalStore } from "react";

/**
 * Carrier logos. Staff upload each carrier's official file once in the
 * admin; every page shows it wherever the carrier is named. Until one is
 * uploaded a carrier gets a lettered badge in its own colour, so the grid
 * still reads at a glance.
 */
export const carrierSlug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** A badge colour per carrier, close to the brand, for the fallback mark. */
const BRAND: Record<string, { bg: string; fg: string; short: string }> = {
  unitedhealthcare: { bg: "#002677", fg: "#ffffff", short: "UHC" },
  gravie: { bg: "#F26B3A", fg: "#ffffff", short: "G" },
  nationwide: { bg: "#1C57A5", fg: "#ffffff", short: "NW" },
  "angle-health": { bg: "#5B3DF5", fg: "#ffffff", short: "A" },
  cobalt: { bg: "#0F4C81", fg: "#ffffff", short: "C" },
  healthez: { bg: "#00A3A1", fg: "#ffffff", short: "EZ" },
  ebpa: { bg: "#2E7D32", fg: "#ffffff", short: "EB" },
  "bcbs-of-alabama": { bg: "#0057B8", fg: "#ffffff", short: "BC" },
  guardian: { bg: "#0A2F5A", fg: "#ffffff", short: "GU" },
  vsp: { bg: "#00539B", fg: "#ffffff", short: "VSP" },
};

export function brandOf(name: string): { bg: string; fg: string; short: string } {
  const b = BRAND[carrierSlug(name)];
  if (b) return b;
  const words = name.replace(/[^A-Za-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  const short = ((words[0]?.[0] || "?") + (words[1]?.[0] || "")).toUpperCase();
  return { bg: "#0F2A47", fg: "#ffffff", short };
}

export const logoUrl = (name: string, bust?: number) => `/api/carriers/${carrierSlug(name)}/logo${bust ? `?v=${bust}` : ""}`;

/** Which carriers have a logo on file — fetched once, shared by every mark on the page. */
let have: Set<string> | null = null;
let version = 0;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

async function load() {
  if (inflight) return inflight;
  inflight = fetch("/api/carriers/logos")
    .then((r) => (r.ok ? r.json() : { carriers: [] }))
    .then((p: { carriers: { carrier: string; logo: boolean }[] }) => {
      have = new Set(p.carriers.filter((c) => c.logo).map((c) => carrierSlug(c.carrier)));
      notify();
    })
    .catch(() => {
      have = new Set();
      notify();
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** After an upload or removal in the admin: re-read, and make every mark re-fetch its image. */
export async function refreshCarrierLogos() {
  version = Date.now();
  await load();
}

export function useCarrierLogos(): { has: (name: string) => boolean; version: number } {
  const snapshot = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => (have ? `${version}:${[...have].join(",")}` : ""),
  );
  useEffect(() => {
    if (!have) void load();
  }, []);
  void snapshot;
  return { has: (name) => !!have && have.has(carrierSlug(name)), version };
}
