import { useEffect, useSyncExternalStore } from "react";

/**
 * Carrier logos. Staff upload each carrier's official file once in the
 * admin; every page shows it wherever the carrier is named. Until one is
 * uploaded a carrier gets a lettered badge in its own colour, so the grid
 * still reads at a glance.
 */
export const carrierSlug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/**
 * Each carrier's icon: its brand colour and a short mark, so every carrier
 * gets a consistent icon the system draws itself rather than a logo file
 * that may not sit well at grid size. Colours are the carriers' primary
 * brand colours; edit here to tune.
 */
const BRAND: Record<string, { bg: string; fg: string; short: string }> = {
  unitedhealthcare: { bg: "#002677", fg: "#ffffff", short: "UHC" },
  gravie: { bg: "#F26B3A", fg: "#ffffff", short: "G" },
  nationwide: { bg: "#1C57A5", fg: "#ffffff", short: "N" },
  "angle-health": { bg: "#5B3DF5", fg: "#ffffff", short: "A" },
  cobalt: { bg: "#0047AB", fg: "#ffffff", short: "C" },
  "optimyl-health": { bg: "#00A388", fg: "#ffffff", short: "O" },
  healthez: { bg: "#00A3A1", fg: "#ffffff", short: "EZ" },
  ebpa: { bg: "#2E7D32", fg: "#ffffff", short: "EB" },
  "bcbs-of-alabama": { bg: "#005EB8", fg: "#ffffff", short: "BC" },
  guardian: { bg: "#0E7C86", fg: "#ffffff", short: "G" },
  vsp: { bg: "#00539B", fg: "#ffffff", short: "VSP" },
  cigna: { bg: "#0033A0", fg: "#ffffff", short: "CI" },
  aetna: { bg: "#7D3F98", fg: "#ffffff", short: "AE" },
  surest: { bg: "#002677", fg: "#ffffff", short: "SU" },
  humana: { bg: "#5C8A2E", fg: "#ffffff", short: "HU" },
};

export function brandOf(name: string): { bg: string; fg: string; short: string } {
  const b = BRAND[carrierSlug(name)];
  if (b) return b;
  const words = name.replace(/[^A-Za-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  const short = ((words[0]?.[0] || "?") + (words[1]?.[0] || "")).toUpperCase();
  return { bg: "#0F2A47", fg: "#ffffff", short };
}

export const logoUrl = (name: string, bust?: number) => `/api/carriers/${carrierSlug(name)}/logo${bust ? `?v=${bust}` : ""}`;

/** Which carriers have a logo on file - fetched once, shared by every mark on the page. */
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
