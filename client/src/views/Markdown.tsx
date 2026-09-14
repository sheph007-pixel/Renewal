import { Fragment, type ReactNode } from "react";
import { C } from "@/lib/ui";

/**
 * The assistant writes Markdown — headings, lists, bold, the odd table — and
 * this turns just that much of it into elements. Everything is built as
 * React nodes from the text, so nothing the model writes is ever set as HTML.
 */
export default function Markdown({ text }: { text: string }) {
  return <div className="md">{blocks(text)}</div>;
}

// A bare address is a link too, so nothing the assistant names has to be copied out by hand.
const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s<>"')\]]+|(?<![\w*])\*[^*\s][^*]*\*(?![\w*]))/g;

/** A bare URL as a link, with trailing punctuation left outside it. */
function bareLink(tok: string, key: number): ReactNode[] {
  const m = tok.match(/^(.*?)([.,;:!?]+)?$/);
  const url = m ? m[1] : tok;
  const tail = m && m[2] ? m[2] : "";
  let label = url.replace(/^https?:\/\//, "");
  if (label.length > 60) label = `${label.slice(0, 57)}…`;
  const out: ReactNode[] = [
    <a key={key} href={url} target="_blank" rel="noreferrer">
      {label}
    </a>,
  ];
  if (tail) out.push(tail);
  return out;
}

function inline(s: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let k = 0;
  for (const m of s.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push(s.slice(last, at));
    const tok = m[0];
    if (tok.startsWith("**")) out.push(<strong key={k++}>{inline(tok.slice(2, -2))}</strong>);
    else if (tok.startsWith("`")) out.push(<code key={k++}>{tok.slice(1, -1)}</code>);
    else if (/^https?:\/\//.test(tok)) out.push(...bareLink(tok, k++));
    else if (tok.startsWith("[")) {
      const i = tok.indexOf("](");
      out.push(
        <a key={k++} href={tok.slice(i + 2, -1)} target="_blank" rel="noreferrer">
          {tok.slice(1, i)}
        </a>,
      );
    } else out.push(<em key={k++}>{inline(tok.slice(1, -1))}</em>);
    last = at + tok.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

const isTableRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
const isRule = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
const cells = (l: string) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

function blocks(text: string): ReactNode[] {
  const lines = text.replace(/\r/g, "").split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      const style = { margin: "12px 0 6px", fontSize: level === 1 ? 16 : level === 2 ? 15 : 14, fontWeight: 600, color: C.ink, lineHeight: 1.35 };
      out.push(level <= 2 ? <h3 key={k++} style={style}>{inline(h[2])}</h3> : <h4 key={k++} style={style}>{inline(h[2])}</h4>);
      i++;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      out.push(<hr key={k++} style={{ border: 0, borderTop: `1px solid ${C.rule}`, margin: "10px 0" }} />);
      i++;
      continue;
    }
    if (isTableRow(line) && i + 1 < lines.length && isRule(lines[i + 1])) {
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && isTableRow(lines[i])) rows.push(cells(lines[i++]));
      out.push(
        <div key={k++} style={{ overflowX: "auto", margin: "8px 0" }}>
          <table style={{ borderCollapse: "collapse", fontSize: 12.5, width: "100%" }}>
            <thead>
              <tr>
                {head.map((c, j) => (
                  <th key={j} style={{ textAlign: j ? "right" : "left", padding: "6px 8px", borderBottom: `1px solid ${C.border}`, fontWeight: 600, color: C.ink, verticalAlign: "bottom" }}>
                    {inline(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {head.map((_, j) => (
                    <td key={j} style={{ textAlign: j ? "right" : "left", padding: "5px 8px", borderBottom: `1px solid ${C.hairline}`, fontVariantNumeric: "tabular-nums" }}>
                      {inline(r[j] ?? "")}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    const bullet = /^\s*[-*•]\s+/;
    const number = /^\s*\d+[.)]\s+/;
    if (bullet.test(line) || number.test(line)) {
      const ordered = number.test(line);
      const re = ordered ? number : bullet;
      const items: string[] = [];
      while (i < lines.length && re.test(lines[i])) {
        let item = lines[i].replace(re, "");
        i++;
        // A wrapped line indented under the item continues it.
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !re.test(lines[i]) && !bullet.test(lines[i]) && !number.test(lines[i])) {
          item += " " + lines[i].trim();
          i++;
        }
        items.push(item);
      }
      const li = items.map((it, j) => <li key={j} style={{ margin: "2px 0" }}>{inline(it)}</li>);
      out.push(ordered ? <ol key={k++} style={{ margin: "6px 0", paddingLeft: 22 }}>{li}</ol> : <ul key={k++} style={{ margin: "6px 0", paddingLeft: 20 }}>{li}</ul>);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4})\s/.test(lines[i]) && !bullet.test(lines[i]) && !number.test(lines[i]) && !(isTableRow(lines[i]) && i + 1 < lines.length && isRule(lines[i + 1]))) {
      para.push(lines[i].trim());
      i++;
    }
    out.push(
      <p key={k++} style={{ margin: "6px 0" }}>
        {para.map((p, j) => (
          <Fragment key={j}>
            {j > 0 && " "}
            {inline(p)}
          </Fragment>
        ))}
      </p>,
    );
  }
  return out;
}
