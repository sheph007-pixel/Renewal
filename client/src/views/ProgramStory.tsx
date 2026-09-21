import { useEffect, useMemo, useState } from "react";
import { C, kicker, panel } from "@/lib/ui";

/** How long each frame holds before the next one, when the story is playing. */
const HOLD_MS = 10000;

interface Tile {
  title: string;
  sub?: string;
}
interface Frame {
  kicker: string;
  title: string;
  lead: string;
  tiles: Tile[];
}

/** The Kennion Program deck, one frame per slide, in its own words. */
const framesFor = (year: string): Frame[] => [
  {
    kicker: `The ${year} Kennion Program`,
    title: "More Options. Smarter, Faster Decisions.",
    lead: `Kennion has expanded its group health offering for ${year} with major national carriers, networks and program partners.`,
    tiles: [{ title: "Same Kennion Team" }, { title: "More Options" }, { title: "Better Technology" }],
  },
  {
    kicker: "Built On Trust",
    title: "50+ Years Of Experience. Built For What’s Next.",
    lead: "A half-century of serving employers, a program that set the standard, and a next chapter shaped by what clients asked for.",
    tiles: [
      { title: "50+ Years", sub: "Serving employers with trusted, expert benefits advice." },
      { title: "2013", sub: "Launch of the Kennion Program." },
      { title: `${year} And Beyond`, sub: "Expanding to meet your requests for more choice." },
    ],
  },
  {
    kicker: "Expanding Our Reach",
    title: "Unprecedented Choice For Your Group",
    lead: "Additional national partners bring expanded group health programs and broader provider networks, backed by the same Kennion team.",
    tiles: [{ title: "Additional National Partners" }, { title: "Expanded Group Health Programs" }, { title: "Broader Provider Networks" }],
  },
  {
    kicker: "Meet BenSync",
    title: "Expert Brokerage Meets AI-Powered Technology",
    lead: "BenSync is Kennion's new benefits decision platform: one simple place to review, model and finalize your strategy.",
    tiles: [{ title: "Easier Renewals" }, { title: "Faster Decisions" }, { title: "Total Clarity" }],
  },
  {
    kicker: "Guided By AI. Backed By Your Team.",
    title: "Technology Does Not Replace Our Team",
    lead: "Your dedicated Kennion experts are right beside you with personalized advice, service and strategic support.",
    tiles: [{ title: "Kennion Shops The Market" }, { title: "You Review And Compare In BenSync" }, { title: "We Model Your Strategy Together" }],
  },
  {
    kicker: "The Right Strategy",
    title: "We Help You Build The Right Strategy. Then We Handle The Rest.",
    lead: "Kennion shops the market, BenSync makes it easier to understand, and our team narrows the options with you and handles the implementation.",
    tiles: [{ title: "Employee Navigator Setup" }, { title: "Carrier Implementation" }, { title: "Open Enrollment Support" }],
  },
];

/**
 * The Kennion Program, told in six frames that advance on their own about
 * every ten seconds: the story the program deck tells, on the page instead
 * of behind a download. It pauses while the pointer or keyboard is on it
 * and while the tab is hidden, never auto-plays for someone who asked for
 * reduced motion, and can be stepped by hand with the dots and arrows.
 * Every tile is the same size on every frame, so the panel holds still as
 * the story moves.
 */
export default function ProgramStory({ year }: { year: string }) {
  const [i, setI] = useState(0);
  const [held, setHeld] = useState(false);
  const [hidden, setHidden] = useState(false);
  const reduce = useMemo(() => typeof window !== "undefined" && !!window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches, []);
  const playing = !held && !hidden && !reduce;
  const FRAMES = useMemo(() => framesFor(year), [year]);

  useEffect(() => {
    const on = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);

  useEffect(() => {
    if (!playing) return;
    const t = setTimeout(() => setI((n) => (n + 1) % FRAMES.length), HOLD_MS);
    return () => clearTimeout(t);
  }, [playing, i, FRAMES]);

  const f = FRAMES[i];
  const step = (d: number) => setI((n) => (n + d + FRAMES.length) % FRAMES.length);
  const arrow = {
    display: "grid",
    placeItems: "center",
    width: 30,
    height: 30,
    borderRadius: 15,
    border: `1px solid ${C.border}`,
    background: C.card,
    color: C.ink,
    cursor: "pointer",
    fontSize: 15,
    lineHeight: 1,
  } as const;

  return (
    <section
      className="noprint story"
      aria-roledescription="carousel"
      aria-label={`The ${year} Kennion Program`}
      style={{ ...panel, overflow: "hidden", borderColor: C.navy }}
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
    >
      <div style={{ position: "relative", background: C.navy, padding: "24px 28px 26px", minHeight: 250 }}>
        <div key={i} className="story-frame" aria-live="polite" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ ...kicker, color: C.teal }}>{f.kicker}</div>
          <h2 style={{ margin: 0, fontSize: 22, lineHeight: 1.25, fontWeight: 600, color: C.onColor, letterSpacing: "-0.2px", textWrap: "balance" as const }}>{f.title}</h2>
          <p style={{ margin: 0, maxWidth: 640, minHeight: 48, fontSize: 14.5, lineHeight: 1.65, color: C.railInk, textWrap: "pretty" as const }}>{f.lead}</p>
          <div className="story-tiles" style={{ display: "grid", gridTemplateColumns: `repeat(${f.tiles.length}, minmax(0, 1fr))`, gap: 10, marginTop: 6 }}>
            {f.tiles.map((t, k) => (
              <div key={t.title} className="story-tile" style={{ animationDelay: `${120 + k * 90}ms`, minHeight: 86, boxSizing: "border-box", display: "flex", flexDirection: "column", justifyContent: "center", padding: "12px 14px", borderRadius: 8, background: "rgba(255,255,255,0.07)", border: `1px solid ${C.railLine}`, borderLeft: `3px solid ${C.teal}` }}>
                <div style={{ fontSize: 13.5, fontWeight: 600, color: C.onColor, lineHeight: 1.35 }}>{t.title}</div>
                {t.sub && <div style={{ marginTop: 3, fontSize: 12.5, lineHeight: 1.5, color: C.railMuted }}>{t.sub}</div>}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, padding: "10px 16px 10px 20px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }} role="tablist" aria-label="Frames">
          {FRAMES.map((fr, k) => (
            <button
              key={fr.kicker}
              type="button"
              role="tab"
              aria-selected={k === i}
              aria-label={`${k + 1} of ${FRAMES.length}: ${fr.kicker}`}
              onClick={() => setI(k)}
              className={`story-dot${k === i ? " on" : ""}${playing ? "" : " paused"}`}
              style={{ "--story-ms": `${HOLD_MS}ms` } as React.CSSProperties}
            >
              {k === i && <i key={`${i}:${playing}`} />}
            </button>
          ))}
        </div>
        <span style={{ fontSize: 12.5, color: C.faint }}>
          {i + 1} of {FRAMES.length}
        </span>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          <button type="button" className="story-arrow" aria-label="Previous frame" onClick={() => step(-1)} style={arrow}>
            &lsaquo;
          </button>
          <button type="button" className="story-arrow" aria-label="Next frame" onClick={() => step(1)} style={arrow}>
            &rsaquo;
          </button>
        </div>
      </div>
    </section>
  );
}
