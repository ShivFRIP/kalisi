# Hyderabad Office-Commute Shuttle Platform: Architecture & Design

**Draft v0.1 · 26 Oct 2026 · For internal discussion**

**How to read this document.**
- Factual claims carry a confidence tag and a source:
  - **[HIGH]**: a primary source opened and checked.
  - **[MEDIUM]**: a single source or a secondary source that was opened.
  - **[LOW]**: inference, or a search snippet only.
  - **[unverified]**: not checked in this work.
- **✓** marks a source I re-opened and checked myself. Every other tagged source was opened and quoted by a research sub-agent in this session; I did not re-open those.
- Untagged statements are design recommendations or explicit assumptions, not facts.
- Indian figures are on a fiscal-year basis (FY, Apr–Mar) unless marked "CY" (calendar year).

---

## 0. Executive summary

### What to build

A **pre-booked, subscription commute network**.
- **Riders** declare home, office, time windows and days.
- **The platform** matches them to *routes and stops*, not to each other. It plans the network weekly and allocates vehicles each night.
- **Real-time systems** are used only for exceptions: tracking, ETA, skipped days, breakdowns and SOS.
- **Architecture:**
  - a modular-monolith core on PostgreSQL/PostGIS;
  - a separate telemetry and ETA service;
  - a batch planning engine built on OR-Tools.
- **Throughput is not the hard part** (sized in §5.5). Optimisation quality, legality and operations are.

### Five findings that shape the design

1. **The binding constraint is legal, not technical.**
   - Under the Motor Vehicles Act, a vehicle carrying more than six passengers "at separate fares paid by or for individual passengers" is a **stage carriage** (s.2(40)).
   - A **contract carriage** must be hired "for the use of such vehicle as a whole". Its allowance for separate fares covers only a motorcab, defined as ≤ 6 passengers (s.2(7), s.2(25)) **[HIGH ✓]**.
   - Regulators have acted against Shuttl (Delhi, 2017), ZipGo (Bengaluru, 2016), Ola Shuttle (Bengaluru, 2017), and Cityflo and Uber Shuttle (Maharashtra, 2025) **[MEDIUM]**.
   - Telangana has no notified aggregator rules. The state said on 7 Aug 2026 that it has begun preparing an aggregator policy **[MEDIUM]**. **This is a live policy window.**
2. **The market is not empty.**
   - Cityflo already runs 17 route pairs in Hyderabad into Financial District, HITEC City and Knowledge City, at ₹99–259 per one-way ride **[HIGH ✓]**.
   - Uber Shuttle left Hyderabad in 2025, citing low ridership and high operating costs, and has turned to transport for employers (B2B) **[MEDIUM]**.
3. **The police are already asking for this.** On 12 Aug 2026 Cyberabad Traffic Police urged IT firms to run "centralised corporate buses operating from major residential clusters" instead of "multiple low-occupancy shuttles run by individual companies", and to stagger login and logout times **[MEDIUM ✓]**.
4. **The economics hinge on load factor and how spread out the peak is.**
   - Two separate sources put break-even at about **51% seat occupancy**:
     - a WRI cost model from about 2017 **[HIGH, but dated]**;
     - Cityflo's "eighteen of thirty-five seats" after 2020 **[MEDIUM]**.
   - The peak sets fleet size. In the sizing model in §5.5, staggering arrival times cuts the fleet needed by about 28%. That figure depends on the model's assumptions.
5. **Shifting people out of cars is not automatic.** In Delhi-NCR, Shuttl riders came from private cars (51%), other car-based modes (16%) and **the metro (29%)**, and only 2% from public buses (WRI, January 2020, 423 respondents) **[HIGH ✓]**. A Hyderabad service has to be designed so it does not draw riders away from the Metro.

### Recommendation (operating model, §3)

Build **one core that works under any operating model**. Record each trip's legal and commercial mode as data:
- per-seat;
- whole vehicle hired by an employer;
- ticket sold for TGSRTC as the state transport undertaking (STU).

Then pursue **"public rules, private operation, franchised corridors"**:
- **Now (legal under today's law, subject to counsel):** run the pilot on whole-vehicle contracts with an employer or a group of employers (a contract carriage). Alternatively, or as well, make TGSRTC or HMRL the operator of record.
- **In parallel (your highest-leverage move):** draft a shared-shuttle licensing scheme under s.67(3) and s.93 for the coming Telangana aggregator policy. Delhi's 2023 Premium Bus Scheme and Uttar Pradesh's 2026 rules are the templates.
- **At scale:** tender bundles of corridors, so operators compete *for* a corridor rather than *on* it. Splitting riders across rival operators on the same corridor pushes each of them below the ~51% break-even.

### The question to settle first

Does the public interest need a **new app** at all? The alternative is a **public framework**: a legal scheme, open data, corridor franchises and an evaluation design. Existing operators (Cityflo, MoveInSync, TGSRTC) could plug into it. The architecture below works either way. Your comparative advantage as a research organisation lies in the framework and the evaluation (§9.3), not in out-building incumbents.

---

## 1. What kind of problem this is (and why it matters for the architecture)

This is **not** Uber-style on-demand ride-hailing. Four properties define it:

| Property | What it means | Design consequence |
|---|---|---|
| **Known in advance** | Home, office, time window and days are declared up front. Riders change only by exception ("not travelling today"). | Most optimisation runs **offline**: weekly network design and nightly allocation. Real-time systems handle exceptions only, which makes them simpler, cheaper and more robust than live dispatch. |
| **Many-to-few** | Homes are spread across the city; offices sit in a few clusters. | Match **riders to routes and stops**, not riders to riders. sRide-style rider-to-rider matching suits private carpools, not a contracted fleet. |
| **Peak-dominated** | Most seats are needed in two narrow windows. | **Fleet size is set by the peak, not by daily trips.** The "short trips after long trips" idea earns extra revenue from vehicles you already pay for, but it does not shrink the fleet. Spreading office arrival times does. |
| **Tidal** | Vehicles run full inbound in the morning and empty outbound (and the reverse in the evening). | Dead mileage (deadhead) is a large cost. Reverse-commute demand and mid-day feeder loops fill it. |

**The product promise is reliability:** a guaranteed seat, a predictable pickup and an AC vehicle if paid for. Immediacy is not the promise. This drives every trade-off below.

### Three planning horizons

```
 STRATEGIC (weekly/monthly)       TACTICAL (daily, D-1 cut-off)       OPERATIONAL (real time)
 ──────────────────────────       ─────────────────────────────       ───────────────────────
 Demand pool (commute intents)    Tomorrow's confirmed seats          GPS pings, boarding events
 Stop siting                      Rider → trip assignment             Skips, delays, no-shows
 Route + timetable design    ──►  Trip → vehicle (size, AC)      ──►  ETA + notifications
 Fleet mix & operator contracts   Vehicle + driver duty chains        Breakdown re-allocation
 Launch / retire routes           Manifests pushed to driver app      Live ops control tower, SOS
```

---

## 2. Evidence base: Hyderabad context and reference products

### 2.1 Hyderabad context

| Topic | Figure | Basis / units | Conf. | Source |
|---|---|---|---|---|
| IT/ITES jobs, Telangana | 9,39,054 | FY2024-25, persons. Telangana-wide, not Hyderabad only. A news report of the Socio-Economic Outlook 2025; the original was not opened | MEDIUM | [m9.news](https://www.m9.news/technology/telangana-it-growth-dip-in-jobs-raises-concerns/) |
| Where office space is | HITEC City/Madhapur 38%, Gachibowli 17%, Financial District 15% (≈70%). North-west holds 88–89% of Grade-A space | Share of office *area*, not jobs; stock as of 30 Sep 2024 | HIGH | [ICRA, Jan 2025](https://www.icra.in/Rating/DownloadResearchSummaryReport?id=6103) |
| East-side job nodes | Infosys Pocharam: "over 35000" employees. Genpact has a campus at Uppal | Company and news statements | MEDIUM / HIGH | [Morung Express](https://morungexpress.com/wef-2025-infosys-to-expand-hyderabad-campus-create-17000-jobs); [Genpact](https://media.genpact.com/2022-02-13-Genpact-Expands-its-Presence-in-Hyderabad-to-Meet-Ongoing-Market-Demand) |
| Congestion | Average 32 min 37 s per 10 km; morning rush 34 min 53 s; evening rush 39 min 28 s | CY2025 (TomTom Traffic Index 2025) | HIGH | [TomTom](https://www.tomtom.com/traffic-index/hyderabad-traffic/) |
| Metro | 69 km and 57 stations (Phase I); about 4.5 lakh passengers/day; Phase II awaiting Government of India approval; a planned Raidurg–Kokapet Neopolis line (11.6 km) | Network data from HMRL; ridership as of Aug 2026 | HIGH / MEDIUM | [HMRL Phase II](https://hmrl.co.in/phase-ii/); [Siasat](https://www.siasat.com/hyderabad-metro-eyes-12-5l-riders-but-laid-no-new-track-in-a-year-3518542/) |
| Metro ownership | The state government acquired 100% of L&T's metro company | Agreement signed 29 Apr 2026 | MEDIUM | [ETV Bharat](https://www.etvbharat.com/en/state/telangana-clears-metro-phase-ii-hurdles-takes-full-control-pushes-centre-for-swift-nod-enn26050101085) |
| TGSRTC city buses | About 25 lakh passengers/day in Greater Hyderabad. On the IT corridor: 341 buses run 3,467 trips a day on 38 routes | Oct 2026 and Jul 2026 | MEDIUM | [Hans India](https://www.thehansindia.com/news/cities/hyderabad/tgsrtc-launches-common-bus-metro-pass-1127872); [Deccan Chronicle](https://www.deccanchronicle.com/southern-states/telangana/hyderabad-traffic-hit-techies-seek-more-buses-shuttles-to-ease-congestion-1969660) |
| Mahalakshmi (free bus travel for women) | Launched 9 Dec 2023. Women's share of TGSRTC riders rose from 40% to over 67% | Statewide | MEDIUM | [News on AIR](https://www.newsonair.gov.in/tgsrtc-announces-mahalakshmi-free-bus-travel-scheme-saved-travel-costs-of-women-across-state/) |
| Metro + bus common pass | ₹400/day; ₹8,500/month. Excludes Pushpak buses | Launched 2 Oct 2026 | HIGH ✓ / MEDIUM | [HMRL](https://hmrl.co.in/easier-travel-for-hyderabad-city-commuters-deputy-chief-minister-launches-metro-rtc-common-pass/) |
| Existing shuttles | SCSC (Society for Cyberabad Security Council): 13 shuttle buses in the IT corridor and Genome Valley, plus a SHE Shuttle for women. SVIDA (metro last-mile partner): 150 shuttles on 64 routes from 15 stations, about 16,000 riders/day | Jul 2026; Sep 2024 | MEDIUM / HIGH | [Deccan Chronicle](https://www.deccanchronicle.com/southern-states/telangana/hyderabad-traffic-hit-techies-seek-more-buses-shuttles-to-ease-congestion-1969660); [HMRL](https://hmrl.co.in/hyderabad-metro-launches-sustainable-rides-program/) |
| Solo commuting | 10,138 single riders vs 3,584 double riders in one morning-peak hour near Cyber Towers. Vehicle types not stated | Madhapur Traffic Police count, reported Apr 2026 | MEDIUM ✓ | [Telangana Today](https://telanganatoday.com/ride-sharing-to-ease-it-corridor-congestion-finds-hyderabad-police-survey) |
| Police policy ask | Centralised buses from residential clusters; staggered office hours; carpool priority parking | 12 Aug 2026 meeting | MEDIUM ✓ | [Telangana Today](https://telanganatoday.com/cyberabad-police-urge-it-firms-to-revamp-transport-traffic-practices) |
| Open data | Static timetable feeds (GTFS) published for the Metro (Jul 2026) and TGSRTC (Feb 2026). No real-time feed found | Open-data portals | MEDIUM | [OpenCity Metro](https://data.opencity.in/dataset/hyderabad-metro-rail-gtfs); [Mobility Database](https://mobilitydatabase.org/feeds/mdb-3361) |
| State platforms | A state-run ride app was announced in Aug 2026 with no launch date. Mana Yatri runs on ONDC, launched with help from the Telangana government and T-Hub | 2026; 2024 | MEDIUM | [Telangana Today](https://telanganatoday.com/autorickshaw-unions-call-off-strike-as-telangana-govt-agrees-to-fare-hike); [Hans India](https://www.thehansindia.com/news/cities/hyderabad/mana-yatri-hyderabad-a-community-driven-cab-app-861894) |
| Planning baseline | The latest adopted transport study for the metro region dates from 2013, with 2011 survey data | WRI note, Sep 2026 | MEDIUM | [WRI India](https://wri-india.org/sites/default/files/2026-09/expert-note-mobility.pdf) |

**Not found:**
- how Hyderabad IT employees commute (mode share);
- the share of IT employees using employer transport;
- the mode-share targets in the comprehensive mobility plan;
- which Hyderabad routes are reserved for TGSRTC under a state transport scheme.

These gaps matter. **Phase 0 must include a primary demand survey.**

**What this means for the design:**
- **Many-to-few and tidal, confirmed.** About 70% of office space sits in three north-west micro-markets, so mornings flow west. Eastern nodes (Pocharam, Uppal) offer **reverse-commute backhaul** for vehicles that would otherwise return empty.
- **Long trips are long.**
  - At TomTom's morning-rush rate, a 25 km home–office drive takes about 87 min (2.5 × 34 min 53 s).
  - At the evening rate it takes about 99 min (2.5 × 39 min 28 s).
  - This is an extrapolation from a city-wide average.
  - **The detour budget is tight**: long routes need few stops, clustered close together.
- **Price anchors:**
  - The common pass costs ₹8,500/month.
  - Cityflo's per-ride fares come to ₹3,960–10,360 for 40 rides a month, before any pass discount, which was not verified.
  - Women ride TGSRTC buses free. For women commuters, the shuttle has to win on **comfort, safety and time**, not on price.
- **Integration is possible now.** Published Metro and TGSRTC timetable feeds let the planner avoid duplicating the Metro and time feeder loops to train arrivals.

### 2.2 Reference products: what to borrow, what to avoid

| Product | Verified model and features | Borrow | Avoid or learn |
|---|---|---|---|
| **Cityflo** | **Ownership:** operators own the buses; Cityflo "determines vehicle specifications and works with its partners on route planning" [MEDIUM]. **Service:** "premium, air-conditioned coaches" with assigned seats; plans are One-way Ride, Ride Pack and Flexi Pass (weekly 5-day or monthly 20-day, pre-booked) [HIGH ✓]; "Non-refundable" within 30 min of departure; "The bus will not wait" for late riders [HIGH ✓]; live GPS tracking [HIGH ✓]; employers can pay per seat [HIGH]. **Route pruning:** discontinues low-demand routes [MEDIUM]. **Scale:** about 1,300 buses, "120 of… 150 routes are cash positive" (company claim, Sep 2026) [MEDIUM] | Fixed routes with pre-booked passes; reliability over flexibility (strict departures); asset-light operator ownership; ruthless route pruning | **Legal stance.** Cityflo resolved a 2016 Mumbai stoppage by arguing each rider "held a contract before boarding" [MEDIUM, founder-sourced]. That stance was challenged again in Maharashtra in Jul 2025 [MEDIUM]. In Jun 2025 the Karnataka High Court held a contract carriage "cannot pick up or drop passengers en route" [MEDIUM] |
| **sRide** | Peer-to-peer carpool plus Taxipool; "Add your home and office locations"; work-email verification; filter rides "by Friends or Organisation" [HIGH]. In Feb 2022 the RBI cautioned that sRide ran an unauthorised semi-closed prepaid wallet [HIGH]. India status in 2026 is unclear: the Play listing is headed "Active in Top U.S. Cities" and sride.co is parked [LOW interpretation] | Organisation-verified identity; matching filtered by employer or tech park; the onboarding UX | **Stored-value wallets without RBI authorisation (§7).** Peer-to-peer supply is unreliable for a guaranteed-seat product |
| **Quick Ride** | "Recurring ride facility"; "Carpool groups for the same community/tech park/company" [HIGH] | Recurring trips; community groups as the trust unit | — |
| **Shuttl** | Built routes from "a heat-map of demand" [MEDIUM]. Shut in Jun 2021 after the pandemic and was sold to Chalo [MEDIUM]. Rider origins: cars 51%, other car-based 16%, metro 29%, bus 2% [HIGH ✓] | Demand heat-maps lead to route design | Risk of drawing riders off the Metro; demand fragility when offices go work-from-home |
| **ZipGo** | Bengaluru regulators said the rules did not permit a stage-carriage licence for it (2016). It shut its intra-city service in 2019 [MEDIUM] | — | The permit trap |
| **Uber Shuttle** | Hyderabad pilot launched Oct 2024. Exited Mumbai and Hyderabad in 2025 and Delhi after Mar 2026, citing "low ridership and high operating costs"; now focusing on B2B employee transport [MEDIUM] | — | A strong brand did not overcome thin per-seat economics |
| **MoveInSync** | B2B employee transport; "ferries over 5 lakh employees daily" (2023) [MEDIUM]; "fixed, on-demand or dynamic routes and schedules" [HIGH] | Employer rostering; contract-carriage-compatible B2B model | — |

**Unit economics:**
- **WRI cost model (about 2017):** break-even load factor of 51% [HIGH, but dated]. It assumes a 20-seat minibus leased at ₹75,000/month, a ₹100 fare for 25 km and 3 trips/day ([WRI/Shakti](https://shaktifoundation.in/wp-content/uploads/2022/01/Role-of-Bus-Aggregators-in-improving-city-bus-services-in-India.pdf)).
- **Cityflo:** "Eighteen of thirty-five seats" covered a bus's costs; 70% occupancy gave about a 25% gross margin; a new route takes about two quarters to break even [MEDIUM, founder interviews and press].
- **No audited figures were found.**

**Three cross-cutting lessons:**
1. **Every per-seat bus aggregator selling to the public in India has hit the stage-vs-contract-carriage wall.**
2. **The survivors are anchored on employers (B2B) or are asset-light with strict route pruning.** Uber's pivot and MoveInSync's scale both point to B2B.
3. **Demand can vanish suddenly** (COVID, work-from-home). Subscriptions must allow pauses, and operator contracts must share that risk.

**Legality and economics both point the same way: start employer-anchored.**

---

## 3. Operating model: Government-led vs Private vs Open network

### 3.1 The legal crux: vehicle size × fare model → permit category

**Statute text:** Motor Vehicles Act 1988 as consolidated on Indian Kanoon **[HIGH ✓]** ([s.2](https://indiankanoon.org/doc/946665/)):
- **s.2(25) motorcab:** "not more than six passengers excluding the driver".
- **s.2(22) maxicab:** "more than six passengers, but not more than twelve".
- **s.2(7) contract carriage:** hired "for the use of such vehicle as a whole… without stopping to pick up or set down passengers not included in the contract". It "includes (i) a maxicab; and (ii) a motorcab notwithstanding that separate fares are charged for its passengers".
- **s.2(40) stage carriage:** "more than six passengers… at separate fares paid by or for individual passengers".
- **s.2(33) private service vehicle:** carries persons for the owner's "trade or business otherwise than for hire or reward".

**My reading (LOW, not legal advice; get counsel):**

| Vehicle | How riders pay | Likely category | Private operator today |
|---|---|---|---|
| ≤ 6 passengers (motorcab, e.g., a 6+1 MUV) | Per seat | Contract carriage. Separate fares are expressly allowed for motorcabs | Workable with a permit plus an aggregator licence, but Telangana's aggregator rules are not yet notified |
| 7–12 passengers (maxicab, e.g., Tempo Traveller) | Whole vehicle hired by an employer or group | Contract carriage | Workable |
| 7–12 passengers | Per seat | Stage carriage ("paid by or for individual passengers", so even an employer paying per seat may count) | Needs a stage-carriage permit or a state scheme |
| > 12 passengers (bus) | Whole vehicle hired by an employer | Contract carriage (classic employee transport) | Workable |
| > 12 passengers | Per seat | Stage carriage. Routes may also be reserved for TGSRTC under a Chapter VI scheme (s.99, s.104 [HIGH]); the Telangana position was not verified | High risk without a scheme |
| Employer-owned bus, free to employees | — | Private service vehicle | Workable |
| TGSRTC-operated | Per seat | Stage carriage run by the state transport undertaking (TGSRTC) | Workable for TGSRTC |

**Design consequence: the vehicle class determines the legal fare model.** The platform must enforce this in code (§3.4).

**Tools the state already has:**
- **s.67(3)** lets the state "make schemes for the transportation of goods and passengers and issue licences under such scheme".
- **s.93** licenses aggregators, and separately licenses agents "in the sale of tickets for travel by public service vehicles".
- Both [HIGH] ([s.67](https://indiankanoon.org/doc/785258/), [s.93](https://indiankanoon.org/doc/1798953/)).

**Templates from other states:**
- **Delhi Premium Bus Scheme (notified 20 Nov 2023)** [MEDIUM] ([SCC Online](https://www.scconline.com/blog/post/2023/11/21/delhi-government-notifies-scheme-for-premium-buses/); [Business Today](https://businesstoday.in/amp/latest/in-focus/story/delhi-govt-notifies-premium-bus-aggregator-scheme-all-about-it-406743-2023-11-22)):
  - buses with ≥ 9 seats, AC, Wi-Fi, GPS, CCTV and a panic button;
  - buses hold a "Contract Carriage permit"; pick-up and drop only at notified bus shelters;
  - buses joining after 1 Jan 2025 must be electric;
  - the May 2023 draft barred physical tickets and set the base fare no lower than the peak fare of Delhi's state-run AC buses (DTC) ([TaxGuru](https://taxguru.in/corporate-law/draft-delhi-motor-vehicles-licensing-aggregator-premium-buses-scheme-2023.html)).
  - Uber received the first licence in May 2024 [MEDIUM] but closed its Delhi shuttle after Mar 2026 [MEDIUM]. **A legal licence did not guarantee viability.**
- **Uttar Pradesh rules (22 May 2026)** cover aggregators that onboard buses, with fares between 50% and 150% of the base fare [MEDIUM] ([Argus](https://www.argus-p.com/updates/updates/overview-of-the-uttar-pradesh-motor-vehicle-thirty-third-amendment-aggregator-and-delivery-services-provider-rules-2026/)).

**MoRTH Motor Vehicle Aggregator Guidelines 2025.** Issued as a letter to states dated 1 Jul 2025; states "may adopt" them **[HIGH ✓]**, read from a copy of the signed document ([PDF](https://data.opencity.in/dataset/21201bda-6d31-4810-bd83-2eac226b1854/resource/2241d340-af3d-4c37-8bd5-8ea18e88cad2/download/75e71eaa-a7e6-4962-b2e0-c58808605583.pdf)). Points that matter here:
- **Buses:** in scope; security-deposit slabs are set by bus count.
- **Pooling:** **no ride-pooling clause** (searched the text).
- **Scope exclusions:**
  - cl.2.3 excludes "entities that are engaged in the sale of tickets for travel by public service vehicles";
  - cl.2.2 excludes interoperable-network providers that do not onboard drivers or vehicles.
- **Safety:** AIS-140 tracking device and panic button under CMVR Rule 125H, linked to the State command centre.
- **Driver training:** induction of at least 40 hours, including 6 hours of first-responder training.
- **Fares:** between 0.5× and 2× the base fare; drivers receive at least 80% of the fare.
- **Comparison with 2020:** the 2020 guidelines allowed pooling with "varied stoppages… under a virtual contract through the App" and capped driver login at 12 hours a day [HIGH, per sub-agent] ([2020 PDF](https://cgtransport.gov.in/GadgetPDF_File/26112020_Motor%20Vehicle%20Aggregators26-11-2020.pdf)). Both provisions were dropped in 2025.

### 3.2 Comparing the three models

| Dimension | A. Government-led (TGSRTC / HMRL operates or contracts) | B. Private, Cityflo-style | C. Open network / PPP (state rules + many operators/apps) |
|---|---|---|---|
| **Legal route for per-seat buses** | Clearest: TGSRTC runs stage carriages lawfully. A platform that only *sells tickets* may fall under the cl.2.3 exclusion (LOW inference) | Grey and risky (precedents in §2.2). Clean only for whole-vehicle employer contracts, vehicles of ≤ 6 passengers, or under a future state scheme | Needs a state scheme first; then clean |
| **Speed to launch** | Slow (procurement, approvals) | Fast | Slowest (rules, then onboarding) |
| **Product and operations quality** | Biggest risk | Strongest | Depends on contract design |
| **Rider density (the economic engine)** | One network (good) | One network (good), but picks only profitable corridors | **Fragmentation risk** if operators compete on the same corridor |
| **Integration with Metro and buses** | Best: common pass, MeeTicket, published timetable feeds. HMRL has been 100% state-owned since Apr 2026 [MEDIUM] | Via public timetable feeds only | Via standards (GTFS, Beckn) |
| **Fares** | Political; pressure to extend Mahalakshmi free travel (the common pass already excludes premium Pushpak buses, so a carve-out has precedent; LOW inference) | Market-set | Regulated band (e.g., 0.5×–2× base) |
| **Data** | Public asset. **But DPDP s.17(4) switches off the erasure duty for the State [MEDIUM]**, so privacy safeguards must be self-imposed | Private asset | The state sets data-sharing terms |
| **Hosting and accessibility** | MeitY-empanelled cloud [MEDIUM]; GIGW 3.0, which requires WCAG 2.1 Level AA, also for mobile apps [HIGH] | Any Indian cloud region | Per scheme |
| **Who bears demand risk** | The state | Operator and platform | Gross-cost contracts: the state; net-cost contracts: operators |
| **Typical failure** | Slow, under-designed product; fares politicised | Regulatory seizures; serving only profitable corridors; exit (Uber Shuttle) | Coordination failure; operators below break-even |

### 3.3 Recommendation: "public rules, private operation, franchised corridors"

**1. Bridge (legal under today's law).** Pilot in one office cluster using either or both of:
- **(a) Whole-vehicle contracts with employers.** One option is a multi-employer group. SCSC already runs shuttles and is a natural convenor, and this is exactly what the police asked for. Riders do not pay the operator per seat; the employer or group pays per vehicle.
- **(b) TGSRTC or HMRL as operator of record,** with private vehicles contracted in. Whether TGSRTC can contract private vehicles under its own permits is **unverified**.

Get a written legal opinion on whether a *multi-employer* group counts as one hirer. The Kerala High Court has held that a tourist operator "cannot enter into multiple contracts with more than one person or Group of persons" [MEDIUM] ([LiveLaw](https://www.livelaw.in/high-court/kerala-high-court/kerala-high-court-tourist-buses-not-allowed-pick-up-drop-off-passengers-like-stage-carriage-269295)).

**2. Policy (your highest-leverage move).** Telangana is drafting its aggregator policy now. Submit a **shared-shuttle scheme** under s.67(3)/s.93 with:
- **booking:** per-seat, **pre-booked through the app only**, with no street pick-ups, which protects TGSRTC's stage-carriage role;
- **stops:** only at notified stops;
- **vehicles:** AC, and electric by a set date;
- **safety:** AIS-140 tracking linked to the state command centre;
- **fares:** a floor set relative to TGSRTC AC fares (Delhi's draft did this);
- **data:** mandatory sharing of timetables, live feeds and aggregate origin–destination data;
- **evaluation:** built into the licence;
- **corridors:** franchising rather than open per-route competition.

**3. Scale.**
- Tender **bundles of corridors** for 3–5 years: competition *for* the corridor, not on it.
- Prefer **gross-cost contracts with performance incentives** (on-time running, working AC, ratings) when the planning engine sits with the network authority.
- Prefer **net-cost contracts** if the operator also plans its own routes.
- Ticketing and timetable data stay interoperable.

**Why not open competition on every route:** pooled shuttles have strong economies of density. Two operators splitting a 70%-full corridor each run at about 35%, below the ~51% break-even. Lower fares then do not follow. This is an inference from the break-even data in §2.2.

### 3.4 How the architecture stays neutral across models

- **Operator as tenant.** Every vehicle, driver, trip and settlement belongs to an `operator`. The platform runs single-operator (A or B) or multi-operator (C) from the same code.
- **`trip.commercial_mode`** ∈ {`per_seat`, `whole_vehicle_contract`, `employer_owned`, `stu_ticket`}. The billing engine follows the mode:
  - per-seat fares to riders;
  - per-vehicle invoices to an employer or group, which allocates seats among its employees;
  - or a ticket issued for TGSRTC.
- **Compliance as code.**
  - Per-seat sale on a vehicle carrying more than 6 passengers is blocked unless the trip holds a valid permit or scheme reference.
  - Assignment is blocked if the AIS-140 device, fitness certificate, permit or insurance has lapsed.
  - Fares are kept within a configurable band (e.g., 0.5×–2× base).
- **Plug-in edges.**
  - A Beckn/ONDC adapter (model C).
  - Common-pass or MeeTicket ticketing (model A).
  - A data-sharing API to the state (all models).
  - Hosting abstraction for a MeitY-empanelled cloud (model A).

---

## 4. Product design: users and key journeys

### 4.1 Actors

| Actor | Interface | Core jobs |
|---|---|---|
| Commuter (rider) | Android/iOS app; WhatsApp for notifications as a fallback | Register home/office/schedule; get matched; buy a pass; skip a day; track vehicle; board; rate; get help/SOS |
| Driver | Android app (offline-first, local language, large touch targets, voice prompts) | See the day's duty; navigate; check riders in; mark no-shows; report incidents; SOS; pre-trip vehicle checklist |
| Fleet operator | Web portal | Onboard vehicles/drivers and documents; see assigned duties; attendance; settlements; compliance expiry alerts |
| Platform ops (control tower) | Web console | Live map; exceptions (delay, deviation, SOS, breakdown); re-assign vehicles; rider support |
| Network planner | Web console | Demand heat-maps; proposed routes; what-if scenarios; launch/retire routes |
| Employer (optional B2B) | Web portal | Enrol employees; subsidy rules; campus gate data; usage reports |
| Government/regulator (depends on model) | Dashboards / data feeds | Compliance, safety incidents, aggregate origin–destination (OD) data, GTFS feeds |

### 4.2 Rider onboarding and matching ("find people going my way")

1. **Capture.** The rider enters:
   - home and office (address search plus a draggable pin; the pin is canonical because Indian addresses are unstructured);
   - office arrival window (e.g., 09:00–09:30) and departure window (e.g., 18:00–18:45);
   - days of the week;
   - preferences: AC-only, maximum walk, women-seat preference, wheelchair need.
2. **Normalise.**
   - Snap both points to the road network.
   - Snap the office to a curated **campus catalogue** of IT parks and campuses with their actual gates. A campus often has several gates, and dropping riders at the wrong one adds a 10-minute walk.
   - Compute the direct drive time at that time of day.
3. **Search existing supply.** Look for:
   - stops within walking distance R of home, measured on the walking network rather than straight-line (large gated layouts and arterials like the ORR make crow-flies distance misleading);
   - stops near the office or campus gate;
   - trips that serve that stop pair in order, arrive within the window, run on the rider's days and have seats free.
4. **Score candidates** with a generalised cost:
   `cost = a·walk + b·|arrival − preferred| + c·in-vehicle time + d·price`.
   Reject any option whose **detour ratio** (in-vehicle time ÷ direct drive time) is above a cap, for example 1.6. That cap is a policy parameter to tune.
5. **If matched:** show 1–3 options (time, walk, price, AC), then offer a trial ride or a pass.
6. **If not matched:** add the rider to the **demand pool**, keyed by home H3 cell × office cluster × 15-minute time bucket × day mask.
   - Show "*N* people near you want a similar route; it launches at *M*". Show counts only when *N* ≥ *k* (k-anonymity) so neighbours cannot be inferred.
   - Optionally take a refundable pre-commitment.
7. **Weekly route launch.** The planner clusters the demand pool. A candidate route crosses the viability threshold when its projected load factor is at least X% on the smallest suitable vehicle for at least 4 weekdays. The planner then proposes it, riders confirm, and it launches. This crowd-sourced, demand-gated launch keeps empty routes from ever starting.

"Nearby" therefore means **compatible in walking time, arrival window and direction**, not raw distance. The engine can also offer *flex matches*: "walk 300 m further or leave 15 minutes earlier and you join an existing route".

### 4.3 Daily rhythm (rider side)

| When | What happens |
|---|---|
| D-1, up to the cut-off (e.g., 20:00) | The rider can mark "not travelling tomorrow" (AM, PM or both). **Declaring before the cut-off earns a ride credit.** This makes honest declaration pay, and the released seat goes to the waitlist or a single-ride buyer. |
| D-1, after the cut-off | The allocation job runs. It right-sizes vehicles (e.g., swaps a 26-seater for a 17-seater), merges under-filled trips and publishes manifests. |
| Day D, until T–30 min | Late skip allowed, with a reduced or no credit (policy choice). |
| Day D, pickup | Push and WhatsApp messages: "Vehicle ending 1234, driver first name, 6 min away". Live map, ETA to the pickup stop, then ETA to the destination. |
| Boarding | Rider shows a QR code or rotating OTP; the driver scans or taps. A no-show is recorded only if the vehicle waited the full window, proven by geofence evidence. |
| Drop | Trip closes; a 1-tap rating prompt follows (§4.6). |
| Evening (working late) | Later "late-slot" trips (e.g., 20:30, 22:00) where demand exists. Otherwise a **Guaranteed Ride Home** credit (capped reimbursed cab rides per month) removes the biggest psychological barrier to giving up one's own vehicle. *(Borrowed from US commuter programmes. Alexandria, VA's GRH gives commuters who use alternative modes at least twice a week a free ride home for emergencies or unplanned overtime, "up to four (4) times annually" **[HIGH]**, [alexandriava.gov/go/2679](https://alexandriava.gov/go/2679).)* |

### 4.4 Driver app: the day as a "duty"

```
 DUTY  Mon 02-Nov · Vehicle ending 1234 (17-seat minibus, AC; whole-vehicle employer contract) · Driver: R. K.
 ─────────────────────────────────────────────────────────────────────────
 06:20  Report at parking: Kompally          [Pre-trip checklist: AC ✓ tyres ✓ photo ✓]
 06:45  TRIP 1  LONG  Kompally → Financial District   (14 riders · 6 stops)
 08:40  TRIP 2  SHORT Raidurg Metro ↔ Financial Dist loop ×3 (feeder)
 10:30  BREAK / park at corridor depot (charge, if EV)
 17:30  TRIP 3  SHORT Feeder loop ×2
 18:30  TRIP 4  LONG  Financial District → Kompally   (13 riders · 6 stops)
 20:30  Sign off · worked 7h10 · driving ≤ 6h45 · SPREAD-OVER 14h10 (split shift)
```

**Caution: peak-heavy service creates split shifts.** The example worked only 7h10 but spans 14h10 from start to finish. The scheduler must cap **spread-over** as well as worked and driving hours. Alternatively, swap drivers at the mid-day depot, so that one driver works the AM block and another the PM block. Under the §7 rule, this example duty triggers such a swap. Driver welfare here is both a labour issue and a safety issue.

Per-trip screens:
- **Stop list** with scheduled times.
- **Manifest**: first name, boarding code and pickup stop only. No home addresses, and phone numbers masked through a call bridge.
- **Navigation**: in-app SDK or a deep link to a maps app.
- **Auto arrive/depart** by geofence.
- **Board / no-show buttons**: no-show is enabled only after the wait timer runs out at the stop.
- **Running late?** Tapping it notifies downstream riders.
- **Incident report**: breakdown, accident, rider misconduct, road blocked.
- **SOS.**

Non-functional requirements:
- **Offline-first**: the duty and manifest are cached and events queued, because coverage drops in underpasses.
- **Battery-aware** GPS sampling.
- **Local-language UI**: which languages to support is to be confirmed by driver research.

### 4.5 Ops control tower

- Live map of all vehicles, colour-coded by status (on time / late / off-route / idle / SOS).
- **Exception queue, not a wall of dots.** Alerts fire for:
  - delay greater than X minutes against the schedule;
  - off-route by more than Y m for longer than Z s;
  - stopped for more than N minutes away from a stop;
  - overspeed;
  - SOS;
  - a document expiring within 7 days;
  - a driver not logged in 20 minutes before duty.
- One-click **re-assign trip** to a standby vehicle. Riders are notified automatically.
- Daily dashboards: on-time performance, load factor, detour ratio, deadhead %, complaints and incidents.

### 4.6 Ratings that are useful

- **Do not ask riders what GPS already measures** (punctuality, route adherence, speed); measure it.
- Ask a 1–5 rating plus tags for what only humans can judge:
  - AC working;
  - cleanliness;
  - driver courtesy;
  - driving comfort (harsh braking can also be detected from phone sensors);
  - felt safe.
- Score drivers on objective metrics plus a smoothed rating. Use the score for coaching first and penalties second, because one-tap ratings are noisy and can be biased.
- Drivers can flag rider behaviour too (two-way trust).

---

## 5. System architecture

### 5.1 Logical architecture

```
  CLIENTS   ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────────┐
            │ Rider app    │ │ Driver app   │ │ Ops/Planner  │ │ Operator /       │
            │ Android+iOS  │ │ Android,     │ │ console (web)│ │ Employer portal  │
            │              │ │ offline-first│ │              │ │ (web)            │
            └──────┬───────┘ └──────┬───────┘ └──────┬───────┘ └────────┬─────────┘
                   │ HTTPS/REST      │ MQTT or WSS    │ HTTPS/WSS          │ HTTPS
            ┌──────▼─────────────────▼────────────────▼────────────────────▼──────┐
            │   API gateway · auth (phone OTP, JWT) · RBAC · rate limiting · audit  │
            └──────┬──────────────────────┬───────────────────────────┬────────────┘
     ┌─────────────▼──────────┐  ┌────────▼───────────┐   ┌───────────▼────────────┐
     │ CORE PLATFORM          │  │ TELEMETRY & ETA     │   │ PLANNING ENGINE        │
     │ (modular monolith)     │  │ (separate service)  │   │ (batch workers, Python)│
     │ • Identity & KYC       │  │ • ping ingest       │   │ • stop siting          │
     │ • Riders & intents     │  │ • map-matching      │   │ • route generation     │
     │ • Network: stops,      │  │ • ETA engine        │   │ • daily allocation     │
     │   routes, timetables   │  │ • geofence events   │   │ • vehicle/driver duty  │
     │ • Booking & seat       │  │ • alert rules       │   │   chaining             │
     │   inventory            │  │   (delay, off-route,│   │ • what-if scenarios    │
     │ • Passes, pricing,     │  │   SOS, overspeed)   │   │                        │
     │   credits              │  └─────────┬───────────┘   └───────────┬────────────┘
     │ • Payments & ledger    │            │                           │
     │ • Fleet/driver         │            │                           │
     │   compliance           │            │                           │
     │ • Ratings, incidents,  │            │                           │
     │   support              │            │                           │
     │ • Notifications        │            │                           │
     └──────────┬─────────────┘            │                           │
                │      ┌───────────────────▼───────────────────────────▼──────┐
                └─────►│ EVENT BUS: transactional outbox → Redis Streams/NATS  │
                       │ (move to Kafka only if volume or consumers demand it) │
                       └──────┬─────────────────┬───────────────────┬─────────┘
            ┌─────────────────▼───┐  ┌──────────▼─────────┐  ┌──────▼────────────────┐
    DATA    │ PostgreSQL + PostGIS│  │ Redis: live vehicle│  │ Time-series/analytics │
            │ system of record    │  │ positions, seat    │  │ (TimescaleDB or       │
            │                     │  │ locks, ETA cache   │  │ ClickHouse) + object  │
            └─────────────────────┘  └────────────────────┘  │ storage (raw pings)   │
                                                             └───────────────────────┘
  EXTERNAL  Routing engine (self-hosted, OpenStreetMap-based) · geocoding & live traffic (commercial)
            Payment gateway (UPI AutoPay, UPI, cards) · SMS / WhatsApp / push (FCM/APNs)
            AIS-140 VLT backend · GTFS / GTFS-Realtime publisher · Metro/bus feeds
            ONDC/Beckn gateway (open-network model only)
```

**Why a modular monolith plus two separate services, not 20 microservices.**
- The transactional core (bookings, seats, payments, ledger) needs strong consistency and is low volume. One Postgres database with clear module boundaries is simpler and safer.
- **Telemetry** is split out because it is the only high-frequency, append-only workload and it scales differently.
- **Planning** is split out because it is CPU-heavy batch work with a different language and runtime (Python with operations-research libraries).
- Module boundaries are drawn so a module can later become its own service if team size or scale demands it.

### 5.2 Core data model (abridged)

```
rider(id, phone, name, gender?, employer_id?, kyc_level, consent_version, created_at)
place(id, rider_id, kind[home|office|other], geom, h3_r9, address_text, campus_gate_id?)
commute_intent(id, rider_id, origin_place, dest_place,
               am_arrive_from, am_arrive_to, pm_depart_from, pm_depart_to,
               days_mask, prefs{ac_only, max_walk_m, women_seat_pref, wheelchair},
               status[pooled|matched|paused])
campus(id, name, polygon) · campus_gate(id, campus_id, geom, open_hours)
stop(id, name, geom, h3_r9, kind[virtual|metro|campus_gate|landmark],
     safety_audit{lighting, footpath, shelter}, active)
route(id, code, direction[AM|PM|FEEDER|REVERSE], operator_id?, status[proposed|pilot|live|retired])
route_stop(route_id, seq, stop_id, sched_offset_min, dwell_s)
trip_template(id, route_id, start_time, days_mask, min_vehicle_class, ac_required)
trip(id, template_id, service_date, vehicle_id, driver_id, duty_id, status,
     planned_start, actual_start, actual_end)
vehicle_class(id, seats, ac, fuel[diesel|cng|ev], wheelchair_accessible)
vehicle(id, operator_id, reg_no, class_id, permit_type, permit_valid_to,
        fitness_valid_to, insurance_valid_to, puc_valid_to, vlt_device_id, status)
driver(id, operator_id, licence_no, licence_valid_to, psv_badge?, police_verification,
       training_status, status)
duty(id, service_date, vehicle_id, driver_id, start_depot, end_depot, planned_km, deadhead_km)
duty_item(duty_id, seq, kind[trip|deadhead|break|refuel|charge], trip_id?)
pass(id, rider_id, product[weekly|monthly|10-ride], od_pair, valid_from, valid_to, price, status)
booking(id, rider_id, trip_id, pickup_stop, drop_stop,
        status[confirmed|skipped|boarded|no_show|cancelled], source[pass|single|waitlist])
gps_ping(vehicle_id, ts, geom, speed, heading, source[app|vlt])          -- time-series store
trip_event(trip_id, ts, type[arrive|depart|board|no_show|delay|off_route|sos], payload)
payment(id, rider_id, amount, method, gateway_ref, mandate_id?, status)
ledger_entry(id, txn_id, account, debit, credit)                           -- double-entry
rating(id, booking_id, driver_score, vehicle_score, tags[], comment)
incident(id, trip_id, type, severity, reported_by, status, sla_due)
operator(id, legal_name, gstin, contract_type[gross_cost|net_cost], settlement_terms)
employer(id, name, campus_ids[], subsidy_rules)
demand_cell(h3_home, office_cluster, time_bucket, days_mask, n_riders, oldest_wait) -- planner view
```

**Invariants enforced in the database or service layer:**
- Confirmed bookings on a trip never exceed the seats of the assigned vehicle class.
- Pickup comes before drop in `route_stop.seq`.
- Assignment is blocked automatically if any vehicle or driver document is expired. Compliance is enforced by code, not checklists.
- Money moves only through balanced double-entry ledger transactions.
- Every event carries a client-generated id, so retries from offline phones cannot double-count.

### 5.3 Key APIs and events (illustrative)

```
POST /v1/intents                       {home, office, am_window, pm_window, days, prefs} → {intent_id, matches[] | pooled}
GET  /v1/matches?intent_id=…           → options [{trip_template, pickup_stop, walk_m, eta_window, price, ac}]
POST /v1/passes                        {intent_id, option_id, product} → {payment_link | mandate_setup}
POST /v1/bookings/{id}/skip            {date, legs:[AM|PM]} → {credit}
GET  /v1/trips/{id}/live               → {vehicle_pos, eta_pickup, eta_drop, driver{first_name, photo}, vehicle{reg, class}}
POST /v1/trips/{id}/ratings            {driver_score, vehicle_score, tags[]}
POST /v1/sos                           {trip_id, location}

Driver:   GET /v1/driver/duty?date=…   POST /v1/driver/events (batched, idempotent)
          MQTT topic: vehicles/{vehicle_id}/pings

Events:   IntentCreated · RouteLaunched · BookingConfirmed · SeatReleased · TripStarted
          StopArrived · RiderBoarded · RiderNoShow · DelayDetected · OffRouteDetected
          SOSRaised · TripCompleted · RatingSubmitted · DocumentExpiring · PaymentSettled
```

### 5.4 Real-time pipeline (tracking and ETA)

1. **Ping capture.**
   - The driver app sends a GPS ping every ~5 s while on a trip and every 15–30 s when stationary or deadheading, batched if offline.
   - The AIS-140 tracking device, where fitted, is a **second, independent source**. It covers dead phones and supports regulatory reporting.
2. **Ingest.**
   - Authenticate the device and check the vehicle is on duty, then drop pings with implausible jumps.
   - **Map-match** to the route shape.
3. **State.**
   - Update the vehicle's live position in Redis.
   - Raise geofence-based `StopArrived` / `Departed` events.
4. **ETA.**
   - Remaining path time comes from time-of-day segment speeds.
   - v1 uses the routing engine with historical profiles.
   - v2 learns segment speeds per 15-minute bucket per weekday from the platform's own GPS history. It adds a live correction factor from how this trip is running against plan.
   - Show a **range** ("7–9 min") rather than a falsely precise number.
5. **Notify.**
   - Push an update only when the ETA moves by more than 2 minutes, to avoid notification fatigue.
   - Send "Arriving now" when the vehicle is about 500 m from the stop.
6. **Alerts.** Rule engine for the control tower (§4.5); SOS bypasses all queues.
7. **Archive.**
   - Raw pings go to the time-series store. They are kept for N days for disputes and incidents.
   - After that, only aggregates are kept: segment speeds and trip summaries (data minimisation, §7).

### 5.5 Capacity estimates (assumption-driven; replace with survey data)

The assumptions are design inputs, not data:
- **pilot:** 5,000 active riders, 2 legs/day;
- **vehicle:** 20 seats on average, run at a 70% target load (14 riders per leg);
- **peak:** a vehicle completes about 1.3 long legs within the AM peak;
- **pings:** one every 5 s over a 12-hour operating day.

| Quantity | Arithmetic | Result |
|---|---|---|
| AM legs needed | 5,000 ÷ 14 | ≈ 357 |
| **Fleet (peak-bound)** | 357 ÷ 1.3 | **≈ 275 vehicles** |
| Sensitivity: tight peak (1.0 leg/vehicle) | 357 ÷ 1.0 | 357 vehicles |
| Sensitivity: staggered office hours (1.8 legs/vehicle) | 357 ÷ 1.8 | ≈ 198 vehicles (**−28%** vs base) |
| GPS pings/day (pilot) | 275 × (43,200 s ÷ 5 s = 8,640) | ≈ 2.4 M/day ≈ 55/s average |
| GPS pings/day at 20× scale (100k riders) | × 20 | ≈ 47 M/day ≈ 1,100/s average |
| Seat-bookings/day (pilot) | 5,000 × 2 | 10,000 |

**Takeaways:**
- Throughput is **not** the hard engineering problem. A well-tuned Postgres/Timescale or ClickHouse setup handles this; Kafka-class infrastructure is unnecessary at launch.
- The hard problems are **optimisation quality, travel-time accuracy, address and stop data quality, and operations discipline**.
- The sensitivity rows show that **getting employers to stagger arrival times by 30–60 minutes may cut fleet need more than any algorithm**. A government-backed model is better placed to broker that. This is an inference from the assumed numbers above.

### 5.6 Technology choices

| Layer | Pilot (≤ ~300 vehicles) | Scale (city-wide) | Notes |
|---|---|---|---|
| Rider app | Cross-platform (Flutter or React Native) | Same | One codebase; Android-first testing given the market |
| Driver app | Native Android (Kotlin) or Flutter, offline-first | Same, plus MDM-managed devices | Reliable background GPS matters most |
| Backend core | One language/framework the team knows (e.g., Kotlin/Spring, Go, or Python/Django) | Split hot modules if needed | Boring tech wins |
| DB | PostgreSQL + PostGIS | Read replicas; partitioning | PostGIS: GPL-2.0, actively maintained (Oct 2026) [HIGH] |
| Spatial index | H3 | Same | Apache-2.0; v4.5.0 released May 2026 [HIGH] |
| Routing / matrices | Self-hosted OSRM (BSD-2-Clause) or Valhalla (MIT) on an OSM India extract [HIGH] | Plus our own learned speed profiles | Per-call commercial distance matrices get expensive at planning scale: Google's Pro route matrix costs $3.00 per 1,000 elements for India-billed accounts [HIGH] ([Google India pricing](https://developers.google.com/maps/billing-and-pricing/pricing-india)) |
| Geocoding, live traffic | Commercial API | Same | **Mappls:** distance matrix with live traffic ("Applicable for India only"); no public prices [HIGH]. **Ola Maps:** first 100,000 events/month free, then ₹0.199 per directions request or matrix pair (100K–5M tier, from 1 Sep 2026); no live-traffic API found [HIGH]. **Google:** since Mar 2025, free monthly allowances per product replace the $200 credit; India accounts get 70k/35k/7k [HIGH] |
| Optimisation | Google OR-Tools: capacity, time windows, dropped-visit penalties, pickup-and-delivery pairs **[HIGH ✓]** ([routing](https://developers.google.com/optimization/routing), [pickup & delivery](https://developers.google.com/optimization/routing/pickup_delivery)). VROOM as a fast alternative | Plus CP-SAT / MIP for duty scheduling | OR-Tools: Apache-2.0, active. VROOM: BSD-2-Clause, **last commit Mar 2026**, so watch its maintenance [HIGH] |
| Event bus | Postgres outbox + Redis Streams/NATS | Kafka if needed | |
| Telemetry store | TimescaleDB | ClickHouse | |
| Transit data out | GTFS + GTFS-Realtime (TripUpdate, VehiclePosition, Alert entities **[HIGH]**, [GTFS-RT reference](https://gtfs.org/documentation/realtime/reference/)); GTFS-Flex for demand-responsive parts (adopted into GTFS in March 2024 **[HIGH]**, [gtfs.org Flex](https://gtfs.org/extensions/flex/)) | Same | Lets the service appear in third-party trip planners |
| Hosting | Indian cloud region | Multi-AZ | The MoRTH 2020 guidelines required data on servers in India; the 2025 version defers to the DPDP Act [per sub-agent comparison]. Host in India anyway. Government model: MeitY-empanelled provider [MEDIUM] |

---

## 6. The planning engine (the hard part)

### 6.1 Stop siting (strategic)

- **Candidate stops** are points where a vehicle of the given class can stop legally and safely: not on flyovers, not in the ORR main carriageway, with a bay or wide shoulder. Add metro stations, campus gates and landmarks.
- **Solve** a maximal-covering / p-median model: choose *p* stops to minimise total rider walk, with walk ≤ R. R may differ by time of day: shorter at night, and women-sensitive.
- **Human in the loop.** A field audit of each proposed stop checks lighting at 21:00, the footpath and shade, and that a vehicle can actually stop there. Stops are expensive to change once riders learn them.

### 6.2 Route and timetable generation (strategic)

- **Decompose by office cluster × arrival bucket.** For example: Financial District, arriving 09:00–09:30. Within a cluster, multiple drop gates are allowed.
- **Model:** capacitated vehicle routing with time windows, a heterogeneous fleet and a **maximum ride-time constraint**: `in_vehicle ≤ min(α · direct, direct + β)`.
- **Objective:**
  `Σ fixed cost per vehicle + Σ cost/km · km + λ · Σ rider excess time + μ · (change vs current network)`.
- **The stability term μ matters.** Commuters hate route churn. Re-optimise weekly, but publish changes only when the gain beats a threshold or at a monthly service change.
- **Output:** proposed routes and timetables, which the planner reviews in the console with what-if tools (e.g., add a Kokapet drop, or swap to 26-seaters).

### 6.3 Daily allocation (tactical, runs after the D-1 cut-off)

1. Load tomorrow's trip templates and bookings minus skips, plus the waitlist.
2. Load available vehicles and drivers, filtered by **compliance status**, attendance and leave.
3. **Right-size:** pick the smallest vehicle class that holds the booked count plus a buffer and meets the AC requirement.
4. **Merge or split** trips where that is cheaper *and* every affected rider stays within their time guarantee.
5. **Duty chaining** (6.4).
6. Publish manifests and push "your vehicle tomorrow" notifications.

### 6.4 Vehicle and driver duty chaining: "long trip, then short trips"

- **Graph:**
  - each node is a trip, with start place/time and end place/time;
  - an edge i → j exists if `end_i + deadhead(i→j) + turnaround ≤ start_j`;
  - edge cost = deadhead km × cost + idle time × cost.
- **Constraints:**
  - vehicle-class compatibility;
  - driver maximum worked hours, driving hours, **spread-over**, and mandatory breaks (internal 12-hour duty cap; see §7 and the split-shift caution in §4.4);
  - start and end depot (operator parking or driver home);
  - state of charge for EVs (the mid-day dwell doubles as the charging window).
- **Solvers:**
  - single depot and one vehicle class: min-cost flow (polynomial);
  - multi-depot, multi-class: set partitioning with column generation, or a CP-SAT model;
  - pilot scale: OR-Tools is enough.
- **The typical Hyderabad duty pattern this produces:** AM long inbound leg → mid-morning **short feeder loops** from metro stations to campuses, or inter-campus shuttles → park and charge mid-day → PM short loops → PM long outbound leg. **Reverse-commute legs** (e.g., west → east in the morning) fill the tidal empty returns and should be priced cheaper to attract riders.
- **An infrastructure need this surfaces:** secure **mid-day parking and charging inside the IT corridor**. Without it, vehicles deadhead home and the short-trip strategy collapses. This is a natural government contribution under any model.

### 6.5 Real-time re-allocation (operational)

- **Breakdown:** find the nearest standby or idle vehicle of an adequate class, then re-assign the trip and notify riders. Keeping *k* standby vehicles per corridor during peaks is the reliability buffer, and it is a cost line to plan for.
- **Delay propagation:** if trip *i* runs late, its successors in the duty run late too. The engine proposes swaps (another vehicle takes trip *i+1*) or warns the riders affected.

### 6.6 Learning loop

| Signal | Feeds |
|---|---|
| Actual segment travel times | Speed profiles → better ETAs and more realistic timetables |
| Skip and no-show rates (by rider, weekday, season) | Tomorrow's load forecast → vehicle right-sizing |
| Ratings and incidents | Driver coaching; stop safety re-audit |
| Unmatched demand-pool growth | Next route launches |

**Caution on overbooking:** airline-style overbooking breaks the "guaranteed seat" promise. Prefer incentive-compatible skip credits (§4.3) and waitlists. If overbooking is ever used, cap it hard and keep a standby vehicle.

---

## 7. Trust, safety and compliance

| Area | Requirement (verified) | Design response |
|---|---|---|
| **Vehicle tracking and panic button** | CMVR Rule 125H (GSR 1095(E), 28 Nov 2016). The Supreme Court order of 13 May 2026 records that "less than 1% of transport vehicles" have the tracking device. It directs that no public service vehicle get a fitness certificate or permit without a verified device, and that vehicles registered up to 31 Dec 2018 be retrofitted. MoRTH says enforcement runs through Vahan from 1 Jan 2026 [HIGH] ([SC order](https://indiankanoon.org/doc/74316463/)). The 2025 guidelines link the device to the State command centre [HIGH ✓] | Treat the AIS-140 device as a hard gate on assignment. Ingest its feed as a second location source. Hyderabad police asked operators in 2019 to link app panic buttons to the Hawk Eye app [MEDIUM] ([TNM](https://www.thenewsminute.com/telangana/panic-button-hyderabad-cabs-now-police-launch-new-initiative-110135)); confirm today's channel with the police |
| **Driver training and welfare** | Induction training of at least 40 hours including 6 hours of first-responder training. Drivers get at least 80% of the fare (60% on aggregator-owned vehicles). Driver health cover ₹5 lakh and term cover ₹10 lakh; passenger insurance at least ₹5 lakh [HIGH ✓ / per sub-agent] | Track training as a compliance document. As internal rules, the duty scheduler caps worked time at 12 hours (the 2020 benchmark) and caps spread-over at a limit agreed with operators (e.g., 12–13 hours). Longer spreads trigger a mid-day driver swap. Any statutory limits under labour law are **[unverified; legal check]** |
| **Control room and grievances** | 24x7 control room; a Grievance Officer whose details are published in the app and on the website [HIGH ✓] | Ops control tower (§4.5); in-app grievance tracking with service-level timers |
| **Personal data (DPDP)** | DPDP Rules notified 13/14 Nov 2025 (sources differ by a day). Most duties start 18 months later, about **May 2027** [HIGH ([PIB](https://static.pib.gov.in/WriteReadData/specificdocs/documents/2025/nov/doc20251117695301.pdf)) / MEDIUM]. Duties include: consent that is "free, specific, informed, unconditional and unambiguous"; an itemised notice; withdrawal as easy as giving consent; erasure once the purpose ends; reporting a breach to the Data Protection Board "within seventy-two hours"; no "tracking or behavioural monitoring of children". Large processors may be designated Significant Data Fiduciaries, which brings an annual assessment and audit [MEDIUM] ([dpdpa.com](https://dpdpa.com/dpdparules/rule7.html)) | **Privacy by design:** riders' homes never leave the platform, because drivers see only stops; phone numbers are masked; only *vehicles* are tracked, never riders; demand counts are shown only when at least *k* people are in a cell; raw GPS is deleted after N days and only aggregates are kept; no under-18 accounts (or verified parental consent). Build to the 2027 duties now. If a state body operates the platform, **adopt erasure voluntarily** despite the s.17(4) exemption |
| **Recurring payments** | RBI e-mandate framework, 2026: "All recurring transactions may be authorised without AFA up to ₹15,000/- per transaction", with a pre-debit notice "at least 24 hours prior" [HIGH] ([RBI](https://www.rbi.org.in/Scripts/BS_ViewMasDirections.aspx?id=13374)) | Monthly passes, which fall within the price range in §2.1, fit under the ₹15,000 limit. Use UPI AutoPay or card mandates; the 24-hour notice doubles as a reminder to renew |
| **Wallets and ride credits** | Closed-system prepaid instruments, usable "from that entity only", need no RBI authorisation. Any other prepaid instrument needs RBI approval and ₹5 crore net worth [HIGH] ([RBI PPI MD](https://rbi.org.in/scripts/BS_ViewMasDirections.aspx?id=12156)). **Precedent:** the RBI cautioned the public against sRide's unauthorised semi-closed wallet (2022) [HIGH] ([RBI](https://www.rbi.org.in/Scripts/BS_PressReleaseDisplay.aspx?prid=53305)) | Make skip "credits" **non-monetary ride entitlements** tied to the rider's pass, or refund to the original payment method. Avoid a stored-value wallet usable across operators. Get a legal opinion (LOW inference) |
| **Collecting fares for operators** | Payment aggregators "shall not carry out marketplace business", and funds must sit in an escrow account [HIGH] ([RBI PA MD](https://rbi.org.in/scripts/BS_ViewMasDirections.aspx?id=12896)) | Act as a **merchant of a licensed payment aggregator**, with operators onboarded as sellers. Settle with operators from a double-entry ledger (LOW inference; confirm with counsel) |
| **Accessibility** | GIGW 3.0 requires WCAG 2.1 Level AA, including mobile apps, for central and state government [HIGH] ([GIGW](https://guidelines.india.gov.in/?p=10063)). The Chief Commissioner for Persons with Disabilities has applied s.46 of the RPwD Act to private providers including Ola [MEDIUM, Sep 2025, may be outdated] | Target WCAG 2.1 AA under every model. Add a wheelchair-accessible vehicle class, and step-free stops where possible |
| **Women's safety** | (Design, not regulation.) | Option for women-preferred seats; at night, avoid ordering stops so that a lone woman is the last drop-off, and where unavoidable drop at her door with live monitoring; share-my-trip; night audits of stop lighting. Employer night-shift transport duties under state labour law may already set rules **[unverified; check]** |

---

## 8. Integration with public transport and open data

- **Read public timetables (GTFS) in.**
  - Sources: the HMRL Metro feed (Jul 2026) and the TGSRTC feed (Feb 2026, listed with 1,031 routes) [MEDIUM].
  - **Uses:**
    - flag candidate routes that duplicate the Metro (the guard against the "29% from metro" problem);
    - time feeder loops to train arrivals;
    - show riders multimodal alternatives honestly.
- **Publish our own timetables out.**
  - Static GTFS plus GTFS-Realtime (TripUpdate, VehiclePosition, Alert) [HIGH ✓].
  - **GTFS-Flex** for the demand-responsive parts; it was adopted into GTFS in March 2024 [HIGH ✓].
  - The service then appears in third-party trip planners. Under a public scheme, require this as a licence condition.
- **Metro feeder role.**
  - Make short trips anchored at Metro stations the default mid-day use of vehicles.
  - SVIDA (150 shuttles) and Rapido (₹30 flat fares at all 57 stations, Dec 2024) [HIGH] already serve this market. **Partner or share data; don't duplicate.**
- **Fare integration (model A).** Accept the Metro–RTC common pass or MeeTicket as payment or entitlement for feeder trips; a premium supplement could apply on long AC trips.
- **ONDC/Beckn (model C).**
  - The MoRTH 2025 guidelines exclude interoperable network layers that don't onboard drivers or vehicles (cl.2.2) [HIGH ✓], so the network layer is light on regulation.
  - ONDC lists nine metro systems live for public transport, but not Hyderabad [HIGH for that page's content] ([ONDC](https://www.ondc.org/pages/public-transport.html)).
  - Mana Yatri already runs on ONDC in Hyderabad [MEDIUM].
  - Build a Beckn adapter only when there is a second app to talk to.
- **Safety integration.** AIS-140 devices linked to the State command centre; SOS escalation to police per the agreed protocol (§7).
- **Data back to planners (the public-good dividend).**
  - Share aggregate origin–destination matrices, with k-anonymity at the H3 level, plus segment speeds with HMDA/HUMTA.
  - The latest adopted transport study for the metro region rests on 2011 survey data [MEDIUM]. The platform's demand pool would be among the freshest commute data in the city.

---

## 9. Metrics and evaluation

### 9.1 Operating KPIs

- **Load factor** by trip, route and hour.
- **On-time performance:** pickup within ±3 min of schedule.
- **Average and 95th-percentile detour ratio.**
- **Deadhead %**: share of vehicle-km run empty.
- **Vehicle productivity:** revenue hours ÷ duty hours.
- **Cost per seat-km and per rider-trip.**
- **Subsidy per rider-trip** (government model).
- **Retention:** pass renewal rate.
- **Ratings and complaint rate.**
- **Safety:** incidents per 100,000 trips.

### 9.2 Policy outcomes (the reason a research organisation should care)

- **Mode shift is the KPI that matters.** If riders come from buses or the metro, the platform *adds* vehicles to the road.
  - Capture "how did you commute before?" at onboarding (car / two-wheeler / ride-hailing / company cab / bus / metro / other).
  - Repeat the question at 3 and 6 months.
- **Net vehicle-km avoided** = private vehicle-km displaced − shuttle vehicle-km, *including deadhead*.
- **Emissions avoided:** apply fuel-specific factors to net vehicle-km.
- **Equity:** rider income and gender mix; price relative to public transport.

### 9.3 Evaluation design (the non-obvious angle)

The platform can be built so its impact is **causally measurable** from day one:
- **Staggered corridor roll-out.** Launch corridors in a randomised or pre-registered order. This supports difference-in-differences on travel times and traffic counts along treated vs not-yet-treated corridors.
- **Randomised encouragement.** At partner employers, offer free trial weeks to a random subset of employees. This identifies the effect on mode choice without denying anyone service.
- **Pre-register the analysis plan.** That protects credibility with government.

---

## 10. Phased roadmap (indicative)

| Phase | Scope | Exit criteria (targets to agree) |
|---|---|---|
| **0. Discovery and legal** | Settle the legal permit route (§3). Run a demand survey with 3–5 anchor employers in one office cluster. Sound out fleet operators. Design data protection. Build the campus-gate catalogue. | Written legal opinion and regulator comfort; at least N pre-registered riders in 3+ residential clusters. |
| **1. Pilot** | One office cluster, 3–5 residential corridors, ~20–40 vehicles. **Planner-assisted** route design (OR-Tools offline, human approval). Rider app MVP (match, pass, track, skip, rate, SOS), driver app MVP, ops console, UPI payments. | Load factor ≥ 60%, on-time ≥ 90%, pass renewal ≥ 70%, zero unresolved safety incidents. |
| **2. Corridor scale** | Automated nightly allocation and duty chaining with short feeder trips. Employer portal. GTFS/GTFS-RT publication. Learned ETAs. | Cost per seat-km trending to target; mode-shift share from car/two-wheeler ≥ X%. |
| **3. City scale / open network** | Multi-operator tenancy. Beckn/ONDC adapter (if chosen). EV fleet and corridor depots. Reverse-commute products. | Per the model chosen in §3. |

**MVP cut.** In: matching, passes, skip, live tracking, ETA, boarding, ratings, SOS, driver duty, ops alerts, UPI. Deferred: employer portal, dynamic pricing, overbooking, multi-operator, Beckn, in-app chat.

---

## 11. Risks and open questions

### 11.1 Risk register

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | **Permit or seizure risk** for per-seat service in vehicles of more than 6 passengers | Critical | Bridge on employer whole-vehicle contracts or TGSRTC as operator; legal opinion in Phase 0; push the s.67(3) scheme; block non-compliant sales in code (§3.4) |
| 2 | **Not enough riders on a corridor** (cf. Uber Shuttle's exit) | High | Demand-gated route launch (§4.2); employer anchors; prune routes quickly; size vehicles to demand |
| 3 | **Peak concentration** drives up fleet cost | High | Broker staggered office hours with employers (police already support this); mid-day feeder and reverse-commute legs |
| 4 | **Drawing riders off the Metro** (cf. 29% for Shuttl) | High (policy) | Timetable-based check for routes that duplicate the Metro; feeder role; measure where riders came from (§9.2) |
| 5 | **Incumbent competition** (Cityflo in Hyderabad; company buses run by MoveInSync and others) | Medium | Differentiate on what incumbents won't do: consolidating several employers, public integration, east–west backhaul, evaluation. Or bring incumbents in under the framework |
| 6 | **Operator quality** (AC failures, driver churn) | Medium | Gross-cost contracts with performance incentives; compliance as code; standby vehicles |
| 7 | **Serious safety incident** | Critical (reputational and regulatory) | AIS-140 tracking and SOS; driver verification and 40-hour training; night stop audits; command-centre link |
| 8 | **Personal data breach** (home addresses and schedules are sensitive) | High | Minimise data; encrypt; virtual stops; 72-hour breach runbook; voluntary erasure even under state operation |
| 9 | **Payments regulation** (credits treated as a prepaid wallet; marketplace collections) | Medium | Non-monetary entitlements; act as a merchant of a licensed payment aggregator; legal opinion |
| 10 | **Travel-time variance** (monsoon flooding, events, Metro Phase II construction on IT-corridor roads if approved) | Medium | Learned speed profiles; seasonal timetables (Cityflo adjusts schedules "Based on weather conditions and passenger demand" [HIGH] ([blog](https://blog.cityflo.com/cityflo-monsoon-camp-update/))); honest ETA ranges |
| 11 | **Demand shock** (work-from-home policy changes) | Medium | Pass pause; operator contracts with volume bands; diversify across employers |

### 11.2 Decisions only you can make (needed before Phase 0 ends)

1. **Sponsor and anchor.** Has any state body (Transport Department, TGSRTC, HMRL, Cyberabad Police/SCSC) shown interest? This decides the bridge in §3.3.
2. **Build vs framework.** Will your organisation build and run software, or design the scheme and evaluation while an operator or the state builds?
3. **Fare philosophy.**
   - A premium service that recovers its costs (Cityflo-like, ₹99–259 per ride).
   - Or a subsidised tool for shifting people out of cars, priced against the ₹8,500/month common pass.
4. **Pilot cluster.** For example, Financial District, the third-largest office micro-market. Include an east-side reverse-commute leg?
5. **Electric vehicles.** Required from day one (Delhi's scheme requires electric buses for new entrants from 2025) or phased?

---

## 12. Self-critique of this design

1. **The weakest link is the legal analysis.**
   - It is my reading of statute text plus enforcement history reported in the press.
   - I could not verify which Hyderabad routes, if any, are reserved for TGSRTC, or any judgment naming Cityflo.
   - If Telangana's new policy legalises per-seat app buses, the employer-first bridge becomes overly cautious, though not wrong.
2. **The numbers in §5.5 come from assumptions, not data.**
   - They assume 20 seats, a 70% load and 1.3 long legs per vehicle per peak.
   - The "−28% fleet" result is simply the 1.3 → 1.8 assumption carried through.
   - No Hyderabad data on how spread out office arrival times are was found. The Phase 0 survey must measure it.
3. **Evidence quality is uneven.**
   - Many Hyderabad facts are MEDIUM (news).
   - Cityflo's scale and economics are company or founder claims.
   - WRI's 51% break-even uses prices from about 2017.
   - The two sources agree, but the second (Cityflo's 18 of 35 seats) is not audited.
   - TomTom figures are city-wide averages, not corridor-specific. TomTom's own data disagree on rush-hour time lost (123 vs 97 hours, unresolved).
4. **There is a tension I haven't resolved.** I recommend corridor franchising *and* suggest bringing incumbents like Cityflo in. An incumbent with 17 Hyderabad routes may resist franchising. The scheme design must decide whether existing routes are grandfathered or tendered.
5. **Unbenchmarked engineering judgements.**
   - "OR-Tools is enough at pilot scale" and "throughput is not the hard part" are reasoned estimates, not measurements. Benchmark them on synthetic Hyderabad demand in Phase 0.
6. **sRide's current Indian operations are unclear.** I used it only for UX and trust patterns, not for evidence about markets.
7. **Not covered yet:**
   - a rupee cost model (cost per vehicle-hour, subsidy per rider-trip);
   - driver supply and labour conditions;
   - a sounding of the operator market.
   These are the next pieces of work.
8. **Units and year basis have been flagged where they matter:**
   - IT jobs are FY;
   - TomTom figures are CY2025;
   - Metro ridership is a point-in-time figure;
   - the year basis of Cityflo's "₹130 crore" revenue was not stated.

---

## 13. Sources

All sources are linked inline at the point of use. Primary sources this design leans on:

**Law and regulation**
- Motor Vehicles Act 1988, s.2 definitions (Indian Kanoon consolidated text) ✓: https://indiankanoon.org/doc/946665/
- MVA s.67 / Chapter VI: https://indiankanoon.org/doc/785258/ · s.93: https://indiankanoon.org/doc/1798953/ · s.99: https://indiankanoon.org/doc/1615733/
- MoRTH Motor Vehicle Aggregator Guidelines 2025 (copy of the signed letter dated 1 Jul 2025) ✓: https://data.opencity.in/dataset/21201bda-6d31-4810-bd83-2eac226b1854/resource/2241d340-af3d-4c37-8bd5-8ea18e88cad2/download/75e71eaa-a7e6-4962-b2e0-c58808605583.pdf
- MoRTH Motor Vehicle Aggregator Guidelines 2020: https://cgtransport.gov.in/GadgetPDF_File/26112020_Motor%20Vehicle%20Aggregators26-11-2020.pdf
- Supreme Court order on AIS-140 tracking devices, 13 May 2026: https://indiankanoon.org/doc/74316463/

**Payments, data and accessibility**
- RBI E-mandate Framework 2026: https://www.rbi.org.in/Scripts/BS_ViewMasDirections.aspx?id=13374
- RBI Master Direction on PPIs: https://rbi.org.in/scripts/BS_ViewMasDirections.aspx?id=12156
- RBI Master Direction on payment aggregators: https://rbi.org.in/scripts/BS_ViewMasDirections.aspx?id=12896
- RBI press release on sRide (2022): https://www.rbi.org.in/Scripts/BS_PressReleaseDisplay.aspx?prid=53305
- PIB explainer on the DPDP Rules 2025: https://static.pib.gov.in/WriteReadData/specificdocs/documents/2025/nov/doc20251117695301.pdf
- GIGW 3.0: https://guidelines.india.gov.in/?p=10063

**Evidence and reference products**
- WRI India, *Understanding the Impact of Bus Aggregators on Urban Mobility in India's National Capital Region* (Jan 2020) ✓: https://wri-india.org/sites/default/files/uploads/Ojas%20Practise%20note.pdf
- Cityflo FAQ ✓: https://www.cityflo.com/faqs · Hyderabad routes ✓: https://www.cityflo.com/routes/hyderabad/
- HMRL Metro–RTC common pass ✓: https://hmrl.co.in/easier-travel-for-hyderabad-city-commuters-deputy-chief-minister-launches-metro-rtc-common-pass/ · Phase II: https://hmrl.co.in/phase-ii/
- ICRA Hyderabad office market (Jan 2025): https://www.icra.in/Rating/DownloadResearchSummaryReport?id=6103
- TomTom Traffic Index, Hyderabad: https://www.tomtom.com/traffic-index/hyderabad-traffic/

**Technical standards and tools**
- GTFS-Realtime reference ✓: https://gtfs.org/documentation/realtime/reference/ · GTFS-Flex ✓: https://gtfs.org/extensions/flex/
- OR-Tools routing ✓: https://developers.google.com/optimization/routing

**Concept reference**
- Guaranteed Ride Home (Alexandria, VA) ✓: https://alexandriava.gov/go/2679
