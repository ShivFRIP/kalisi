# Kalisi commute survey: setup guide

> **Hosting on the Kalisi server (contabo1):** you don't edit `survey.html` there. Put `SURVEY_ENDPOINT`, `SURVEY_ORG_NAME`, `SURVEY_ORG_CONTACT` and `SURVEY_RETENTION` in `deploy/contabo1/.env` and re-run the installer (see `deploy/contabo1/README.md`). The survey is then at `https://<address>/survey/`. Sections 1 (Google Sheet and Apps Script) and everything about the data still apply.

`survey.html` turns the demo into a research survey:
1. It explains the shuttle concept.
2. It asks for consent.
3. It collects each respondent's home area, office, timings, current commute, willingness to pay and preferences.
4. It sends the answers to a **Google Sheet that your organisation controls**.

Respondents don't need to log in.

| File | What it is |
|---|---|
| `survey.html` | The survey page. Host it on your website. |
| `apps-script/Code.gs` | The small script that receives answers and writes them to your Sheet. |

## 1. Create the Sheet and the receiver (about 10 minutes)

1. **Create the Sheet.** In your organisation's Google account, create a new Google Sheet, e.g. "Kalisi survey responses". Use an account your organisation owns, not a personal one.
2. **Add the script.** In the Sheet, open **Extensions → Apps Script**. Delete the sample code, paste in all of `apps-script/Code.gs`, and save.
3. **Deploy it.** Click **Deploy → New deployment** and choose the type **Web app**:
   - **Execute as:** *Me* (the script writes to your Sheet with your permission).
   - **Who has access:** *Anyone* (respondents aren't signed in to Google).
4. **Approve it.** Click **Deploy** and approve the permissions it asks for (access to this spreadsheet).
5. **Copy the URL.** Copy the **Web app URL**. It ends in `/exec`.
6. **Check it.** Open that URL in a browser. You should see `{"ok":true,"service":"Kalisi survey endpoint"}`.

If you edit the script later, use **Deploy → Manage deployments → Edit → New version**, so the same URL keeps working. Saving the code alone does not change what the live URL runs.

**If you already deployed an earlier copy of `Code.gs`:**
1. Paste in the new one and deploy a new version. The participant results (section 5) and the new `home_h3_r8` column need it.
2. If the `responses` tab already has rows, either:
   - rename that tab (e.g. `responses_old`), so the script creates a fresh one with the new columns (the summaries and participant totals then count only the new tab); or
   - insert one column between `home_h3_res` and `home_h3_r7` and type `home_h3_r8` in its header cell.

   Rows are written in a fixed column order, so skipping this step would shift every later answer one column to the right.

## 2. Configure the survey page

Open `survey.html` in a text editor and search for `SURVEY_ENDPOINT`. Fill in these lines:

```js
const SURVEY_ENDPOINT = 'https://script.google.com/macros/s/…/exec';   // from step 1
const ORG_NAME = 'Your organisation';
const ORG_CONTACT = 'privacy@yourorg.org';     // shown to respondents for deletion requests
const RETENTION = '12 months';                 // how long you keep the answers
```

**Address search mode:**
- `GOOGLE_MAPS_API_KEY` is optional. With no key, address search uses the built-in OpenStreetMap data and nothing about the address search leaves the page.
- With a key, see `SETUP.md`. The consent text then tells respondents that Google receives what they type into the search.

## 3. Host it and test it

1. **Host it.** Put `survey.html` on any static host, such as GitHub Pages, Netlify or your organisation's site. It works from any address. Unlike the Google Maps key, the Apps Script URL isn't tied to one domain.
2. **Test it.** Submit one test response. Within a few seconds, a `responses` tab should appear in the Sheet, plus a `contacts` tab if you asked to be contacted. Delete the test rows afterwards.
3. **Tag your distribution channels.** Add `?src=` to the link you send out, e.g. `survey.html?src=scsc` or `survey.html?src=companyA`. The tag is saved with each response in the `source` column, so you can see which channel each answer came from.
   - When a respondent uses **Copy the survey link for a colleague**, the copied link keeps their `src` tag and adds `via=share`. Answers from those links are saved with `+share` on the end, e.g. `scsc+share`.
   - This lets you separate people you reached directly from people referred by earlier respondents (see the note on snowballing in section 5).

**How submission works:**
- The page sends answers as a plain-text POST. Browsers don't run their cross-site permission check (CORS pre-flight) on that kind of request, and Apps Script can't answer that check.
- If the browser still can't read the script's reply, the page sends the answers again in a mode that hides the reply. It then shows "Your answers were sent" without confirming the save.
- **Your Sheet is the source of truth.** Check it after your first test.

I tested this flow against a local stand-in for the endpoint, and tested `Code.gs` against mock Google services. I have not run it against a live Apps Script deployment.

## 4. Where to see the saved data

Everything is in **the Google Sheet you created in step 1**. Nothing is stored in the page, on the hosting site, or with me.

| Tab | What's in it | Who should see it |
|---|---|---|
| `responses` | One row per answer: hexagon cells, timings, current commute, willingness to pay, preferences. No names or phone numbers. | Analysis team only |
| `contacts` | Name, phone, email, for people who asked to hear about a pilot. Linked to `responses` only by `responseId`. | The one person who will contact them |
| `summary_*` | Counts per zone, route and hexagon. Created when you choose **Kalisi → Refresh summaries**. | Rows marked `publishable_k5 = yes` can go into reports |

- **If no tabs appear after a test submission,** open the Sheet's **Extensions → Apps Script → Executions**. Each submission shows there with any error message.
- **The Claude-hosted preview stores nothing.** Its `SURVEY_ENDPOINT` is empty, so it shows the thank-you screen with example numbers and sends no answers anywhere. Only your self-hosted `survey.html`, with your `/exec` URL filled in, saves data.
- **For analysis outside Sheets,** download a tab as CSV (**File → Download**). Tools that read H3 cell IDs can map the hexagon columns directly. Tools that don't can use the `*_cell_lat` / `*_cell_lon` columns.

## 5. Results shown to participants

After someone submits, the thank-you screen shows a short **"What we've heard so far"** panel:
- the total number of answers, and the share who say they would probably or definitely use a shuttle;
- how many people from their home zone have answered, and how many of those work near their office zone;
- the five most requested routes.

The home and route zones are H3 resolution 7, about 5 km² each.

**Why after submitting, not before:** if people saw "58% would use it" or popular routes before answering, some would lean towards the crowd. Survey researchers call this anchoring or bandwagon bias. Showing results only after the answers are saved keeps each response independent. The panel then works as a thank-you, and as a reason to share the link.

**How it is protected:**
- **Small groups.** A zone or route with fewer than 5 responses is never returned, not even its name. To anyone querying the endpoint, it looks exactly like a zone with no responses. The threshold is `K_MIN` in `Code.gs`.
- **Totals only.** The endpoint returns only counts and locality names. Rows and contact details never leave the Sheet.
- **Caching.** Totals are recalculated at most every 5 minutes, so hundreds of people finishing at once don't each re-read the Sheet. A new answer can take up to 5 minutes to show.
- **Known limit.** Someone who checks the totals just before and just after one particular person submits could see that person's effect on the overall total and the "likely to use" percentage. The 5-minute cache makes this harder but doesn't prevent it. The risk is low because those figures reveal nothing about where the person lives. If you want it closed fully, round the totals to the nearest 10 in `stats_`.

**Settings:**
- Turn the panel off with `const SHOW_RESULTS = false;` in `survey.html`.
- If the totals can't be fetched, the panel is simply left out. The answers are already saved by then.
- The panel needs the updated `Code.gs`, deployed as a new version (step 1).

**One thing to watch: snowballing.** The panel encourages sharing, and sharing pulls in people like the sharer, from the same estate or office. That can make early clusters look bigger than they are. Before comparing zones, check the `source` column: compare routes using direct responses only (no `+share`), and treat referred responses as a sign of how keen a cluster is.

## What gets stored: locations as H3 hexagons

Homes and offices are stored as cells of **H3**, the open hexagonal grid, rather than as coordinates. Average cell sizes from the H3 documentation (h3geo.org, "Tables of Cell Statistics Across Resolutions"):

| Resolution | Average area | Average edge length | Used for |
|---|---|---|---|
| 6 | 36.1 km² | 3.72 km | large zones, e.g. a whole corridor end |
| 7 | 5.16 km² | 1.41 km | **origin–destination zones** (`od_h3_r7`) |
| 8 | 0.737 km² | 0.53 km | **home and office roll-ups** (`home_h3_r8`, `office_h3_r8`), for maps shared outside the team |
| 9 | 0.105 km² | 0.20 km | **home cell** (default) and **office cell** (campus scale) |

Cell sizes vary somewhat by location; the documentation gives up to about 2× between the smallest and largest. Each cell also contains the cells of the next resolution up and down, so you can roll any column up to a coarser zone later.

**Privacy and planning settings:**
- The home resolution is set in `survey.html` with `HOME_H3_RES = 9`: cells of about 0.1 km², roughly 400 m across. That is fine enough to decide which street a pickup stop should go on.
- For more privacy, set it to 8 (about 0.7 km², roughly 1 km across). The consent screen and the home-area screens pick up the new size automatically. If you change it after launch, also change `CONSENT_VERSION` (e.g. to `'2026-10-v2'`) so you can tell which wording each respondent agreed to.
- Whatever the setting, every response also carries the resolution-8, 7 and 6 parents, so you can always publish at a coarser level.
- The exact address and the apartment name are **never sent**. The search and the pin run on the respondent's phone, and only the cell IDs leave it.
- If the hexagon library fails to load, the page falls back to a grid of about 500 m. Those rows show `location_method = grid`, and the summaries skip them.

**`responses` tab** (one row per response, no names or phone numbers):
- `responseId`, `submittedAt`, `receivedAt`, `formVersion`, `consentVersion`, `source` (the `?src=` tag, plus `+share` for links copied by an earlier respondent), `durationSec`.
- **Home:**
  - `home_h3` (the cell at `home_h3_res`, 9 by default);
  - `home_h3_r8`, `home_h3_r7` and `home_h3_r6`, its parent cells;
  - `home_cell_lat` and `home_cell_lon`, the cell centre, for mapping in tools that don't read H3;
  - `home_area`, the nearest locality name.
- **Office:**
  - `office_name` and `office_area`;
  - `office_h3` (resolution 9), with parents `office_h3_r8` and `office_h3_r7`;
  - `office_cell_lat` and `office_cell_lon`.
- `od_h3_r7`: home zone `>` office zone. Pivot on this column to get demand by route.
- `location_method` (`h3` or `grid`) and `address_search` (`osm` or `google`).
- `arrive_window` and `leave_window`: the start of the half-hour (arrival) or one-hour (leaving) window, in 24-hour time, e.g. `09:30` means 9:30–10:00 AM; `shift` means shifts or varies. `days`.
- `ride_home`: blank. From consent version `2026-10-v2` everyone is asked when they leave the office, so this column is no longer used. Responses from the earlier version have `yes` or `no` here. The column is kept so existing Sheets don't shift.
- `mode`, `oneway_time`, `monthly_spend`, `employer_transport`;
- `would_use` (5 = definitely … 1 = no), `max_monthly_pass`, `prefs`, `concerns`, `employer_contribution`;
- `gender`, `age_band` (both optional).

**`contacts` tab:** `responseId`, `receivedAt`, `name`, `phone`, `email`. A row exists only if the respondent turned on "Tell me if a pilot starts near me".

**Summary tabs.** Open the Sheet and choose **Kalisi → Refresh summaries**. The menu appears after you reload the Sheet once the script is saved. You can also set a time-driven trigger on `refreshSummaries`, e.g. every hour, under Apps Script → Triggers.

| Tab | One row per | Columns |
|---|---|---|
| `summary_od_r7` | home zone → office zone pair | likely users (would use = "Definitely" or "Probably"), responses, how many now come by car, two-wheeler or cab, the zone IDs, locality names, most common arrival window, `publishable_k5` |
| `summary_home_cells` | home hexagon at `home_h3_res` (resolution 9 by default) | likely users, responses, car/two-wheeler/cab count, cell centre, locality, `publishable_k5` |
| `summary_home_r8` | home hexagon rolled up to resolution 8 | likely users, responses, car/two-wheeler/cab count, locality, `publishable_k5` |
| `summary_office_r8` | office hexagon (resolution 8) | likely users, responses, car/two-wheeler/cab count, locality, most common office name, `publishable_k5` |

Rows are sorted by likely users. `publishable_k5` is "no" when a cell has fewer than 5 responses (`K_MIN` in `Code.gs`). Keep those rows out of anything shared outside the team, or roll them up to the next coarser zone first.

At resolution 9 most home cells will hold only one or two responses, so expect `summary_home_cells` to be mostly "no". Use it inside the team for siting stops; use `summary_home_r8` or `summary_od_r7` for anything shared outside.

I tested the storage and the summaries with 40 synthetic responses against mock Google services. They were not tested against a live Sheet.

**Built-in protections in `Code.gs`:**
- Requests with malformed IDs or bodies are rejected.
- A hidden field (honeypot) silently drops simple bots.
- Every value is capped at 200 characters.
- Values starting with `= + - @` are stored as plain text, so the Sheet can't run them as formulas.
- A lock stops two submissions from interleaving rows.

## Data protection and research ethics

- **Consent screen.** It says what is collected, why, where it's stored, how long it's kept, that taking part is voluntary, and how to get answers deleted (email plus response ID). Respondents must confirm they're 18 or over.
- **Access.** Give only the analysis team access to the Sheet, and keep the `contacts` tab tighter still. A good practice is to move contacts into a separate Sheet that only the person who will contact people can open.
- **Retention.** Delete or fully anonymise the data at the end of the period you state on the consent screen.
- **The DPDP Act's research exemption.** Section 17(2)(b) of the DPDP Act 2023 exempts processing "necessary for research, archiving or statistical purposes" only when the data isn't used for decisions about individuals **and** follows "such standards as may be prescribed". The survey is designed for full consent anyway rather than relying on that exemption.
- **This is personal data, even without names.** A resolution-9 home cell plus an office cell, arrival time, gender and age band will often point to one person, especially for the few people on an unusual route. Treat the `responses` tab as personal data: restricted access, no public sharing of rows, and deletion on request. Only the summary rows marked `publishable_k5 = yes` are suitable to share. This is my reasoning, not a legal opinion.
- **Ethics review.** If your organisation has an ethics review process, run the questionnaire and consent text through it before launch.

## Limits to keep in mind when analysing the results

- **Who answers is self-selected.** It will lean towards people who are interested and online. Treat results as **mapped demand signals** (where, when, at what price), not as citywide estimates. Use the `src` tags to compare channels, such as an employer group versus a residents' welfare association.
- **Stated willingness to pay is usually higher than what people actually pay.** Use it to rank routes, not to set fares. Pre-registration with a small refundable deposit is a stronger signal for launch decisions.
- **Abuse.** A determined spammer can still post junk to the endpoint. Watch for bursts of identical rows or `durationSec` under about 30 seconds, and filter them out at analysis time.
