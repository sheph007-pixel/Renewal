# 2027 Renewal Client Materials

Two evergreen, non-group-specific handouts for the 2027 (1/1/27) renewal
rollout. Neither names a client, a group, a rate or any real figure, so the
same two files can go out to every Kennion client — attached to outreach now,
and again alongside each group's personalized BenSync link once it's ready.

| File | Purpose |
| --- | --- |
| `Kennion-2027-Renewal-Preview.pdf` | A 2-page "coming soon" preview: the 2027 program story, why it's expanding, and how the renewal process will work. Meant to build excitement before a group's specific options are ready. |
| `Your-Guide-To-BenSync.pdf` | A 2-page walkthrough of the BenSync app itself: who does what, and a step-by-step tour (sign in → welcome page → compare options → build strategy & sign up). All screens are illustrated mockups (styled boxes/bars), not real screenshots — no group data appears anywhere. |

Both match the live app's branding (`client/src/lib/ui.ts` — navy `#0F2A47`,
BenSync green `#1F8A5B`, teal accent `#7FD6A8`) and reuse the same program
language as the in-app Welcome page (`client/src/views/Home.tsx`,
`client/src/views/ProgramStory.tsx`).

## Editing

The `source/` folder has the standalone HTML each PDF was printed from — Inter
(variable font) and the BenSync wordmark are embedded as base64, so each file
opens and edits with no external dependencies. To change copy or styling,
edit the HTML directly, then re-print to a US Letter PDF with zero margins
(e.g. a headless Chromium `page.pdf({ width: '8.5in', height: '11in',
printBackground: true, margin: { top: 0, bottom: 0, left: 0, right: 0 } })`,
or a browser's own "Print to PDF" with margins set to "None").

To reuse this pair for a future renewal year, update the year references (the
"2027 Renewal Preview" pill, "2027" stat tile, "January 1" copy) and re-print.
