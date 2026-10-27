# What Namma Yatri's code teaches us, read for the Kalisi shuttle platform

**Prepared:** 27 Oct 2026.

**Code reviewed:**
- github.com/nammayatri/nammayatri, commit `923c41d`, dated 27 Oct 2026.
- Licence AGPL-3.0, confirmed from the repository's LICENSE file.

**Scope:**
- This repository holds the **backend only**. It has 5,322 Haskell files across the rider platform, the driver/provider platform and about 20 shared libraries.
- The mobile apps are not in it. Several key services live in **other repositories**: location tracking, the bus timetable server, notifications, and the shared kernel that holds the payment and database clients.

**Method:**
- Four read-only reviews ran in parallel: architecture, matching and location, money, and transit/safety/onboarding.
- Nothing was built or run.
- **✓** marks findings I re-checked in the source myself. Other findings come from the reviews, with file references so anyone can check them.
- Paths are shortened as follows:
  - `RA/` = `Backend/app/rider-platform/rider-app/Main/`
  - `DA/` = `Backend/app/provider-platform/dynamic-offer-driver-app/Main/`
  - `LIB/` = `Backend/lib/`

---

## 1. The ten things worth knowing

1. **Namma Yatri can already sell shuttle seats.**
   - Its fixed-route, fixed-schedule ticketing for metro and bus over ONDC (called FRFS) has a `SHUTTLE` service tier ✓ (`LIB/beckn-spec/src/BecknV2/FRFS/Enums.hs:82`).
   - It sends shuttle booking and tracking notifications, including WhatsApp ✓ (`RA/src/Tools/Notifications.hs:2430-2482`).
   - **So a Kalisi shuttle could be listed inside Namma Yatri, or Hyderabad's Mana Yatri, as an ONDC seller, instead of needing its own rider app.**
2. **There is a recurring-commute feature, "NY Regular", but it books a whole car for one rider.**
   - A rider declares pickup, drop, days of the week and time of day once ✓ (`RA/spec/Storage/ny_regular_subscriptions.yaml`).
   - A daily job creates each day's ride.
   - There is no seat pooling, so for shuttles the *pattern* is useful but the *model* is not.
3. **The most reusable piece is the seat-hold model.**
   - Seats are held per **stretch between stops** (e.g. "stop 3 to stop 7") using an atomic, expiring hold ✓ (`RA/src/SharedLogic/FRFSSeatBooking.hs:67-125`).
   - A seat can be sold again for a stretch that doesn't overlap.
   - The model also supports women-only seats and minimum-distance rules.
4. **Scheduled rides use a careful feasibility check worth copying for chaining a driver's long and short trips.**
   - A driver can hold only so many future rides.
   - A new ride must fit between the driver's previous and next ride, allowing for empty driving and a buffer, or it is refused ✓ (`DA/src/SharedLogic/ScheduledBooking/OverlapCheck.hs:108-169`).
   - The code comments explicitly mention recurring commutes.
5. **Bus operations already exist ("Where Is My Bus").**
   - Trips are assigned to a driver and conductor and move through ASSIGNED → IN_PROGRESS → COMPLETED.
   - When a trip ends, the return trip can be assigned automatically ✓ (`DA/src/SharedLogic/WMB.hs:270`).
   - Fleet alerts cover missed stops, skipped stops, wrong direction, overspeeding and trips not started.
6. **Money is handled the "right" way.**
   - There is a double-entry ledger library with append-only history and reversals instead of edits (`LIB/finance-kernel`).
   - Prepaid ride credit expires into revenue ✓ (`DA/src/SharedLogic/Finance/Prepaid.hs`).
   - UPI mandates send a pre-debit notice and fall back to a manual payment.
   - **Gap:** rider passes are one-off payments with no AutoPay ✓ (`RA/src/Domain/Action/UI/Pass.hs:426`, `createMandate = Nothing`).
7. **"Zero commission" is enforced in code.**
   - Drivers who stop paying their subscription are left out of the driver pool and get no new rides ✓ (`DA/src/Storage/Queries/Person/GetNearestDrivers.hs:270`).
8. **Policy lives in versioned rules, not code.**
   - Driver ranking, pricing and penalties are city-specific rule sets that can be A/B tested (`LIB/yudhishthira`, `LIB/behavior-engine`, `LIB/consequence-engine`).
   - That suits a public-interest operator: rules can be published and audited.
9. **Safety is serious but built around cabs.**
   - SOS can stream the rider's location to the national 112 emergency system (ERSS) ✓ (`RA/src/Domain/Action/UI/Sos.hs:244-280`).
   - Route deviations escalate through an automated call, then customer support, then police monitoring.
   - But an SOS request carries only a ride ID and a location ✓ (`RA/spec/API/sos.yaml`). **On a bus or shuttle it has no vehicle or trip context.**
10. **Copy the privacy lesson, not the design.** The bus **trip manifest returns each passenger's decrypted mobile number** to the operator side ✓:
    - `RA/src/Domain/Action/UI/FRFSTicketService.hs:1987-2000` decrypts and includes `phone`;
    - an authenticated provider-side endpoint fetches it (`DA/spec/API/FRFSFleetOperator.yaml:160`).

    Kalisi's manifest should show first name, seat and stop only, with masked calling.

---

## 2. How the system is built

- **Two apps that talk only through the Beckn protocol** (the standard ONDC uses):
  - the **rider app** acts as the buyer side (BAP);
  - the **driver app** acts as the seller side (BPP) and owns fares and dispatch.
  - Every message is acknowledged at once and answered by a later callback.
  - The rider app can send searches to Namma Yatri's own gateway, the ONDC gateway or a newer gateway. So it can buy from *other* providers on ONDC (`RA/src/SharedLogic/GatewayLookup.hs:55-63`).
- **Background workers:**
  - a dispatch "allocator" with about 60 job types;
  - schedulers on both sides;
  - "drainers" that write Redis changes to Postgres and Kafka;
  - Kafka consumers;
  - an analytics event pipeline.
- **Data:**
  - Postgres, with a read replica;
  - Redis for cache, locks, job queues and a write-first layer;
  - Kafka;
  - ClickHouse for analytics.
- **Live driver location** is held in an external Location Tracking Service (LTS).
- **Configuration has three layers:**
  - files for infrastructure;
  - database tables per city with caching and staged experiments (`LIB/config-pilot`);
  - a client-config service for the apps.
- **Code generation:** YAML specs generate API types, routes, database tables, queries and migrations. More than half the backend is generated.
  - Rider side: 216 specs → 906 generated files.
  - Driver side: 252 specs → 1,059 generated files.
- **Multiple operators and cities:**
  - everything is keyed by **operator → operating city**;
  - a new city is created by cloning a base city's configuration from the dashboard (`DA/src/Domain/Action/Dashboard/Management/Merchant.hs:3881-4200`);
  - vehicle categories include BUS, and service tiers include `BUS_AC` and `BUS_NON_AC` ✓.
- **Reliability:**
  - each incoming protocol message is checked for duplicates and locked;
  - jobs report explicit outcomes (Retry, Reschedule, Terminate) with retry limits;
  - roughly 144 lock call sites.

**Is it reusable as is?** Barely. The stack is heavy for a small team: Haskell, Nix, Redis write-behind, Kafka, ClickHouse and several external services. The **patterns** travel well; the stack probably doesn't.

---

## 3. Component by component

### 3.1 Recurring commutes ("NY Regular") ✓

**How it works:**
- A subscription stores:
  - pickup and drop locations;
  - `recurrenceRuleDays` (days of the week);
  - `scheduledTimeOfDay`;
  - an optional end date and a pause window;
  - a `fixedPrice` (set to nothing at creation, and nothing reads it);
  - the provider;
  - a `schedulingHash`.
- A daily per-city master job creates one instance job per subscription, by default 15 minutes before pickup.
- That job cancels itself if the subscription's hash has changed. Otherwise it runs a reserved search and auto-selects the result.

**For Kalisi:**
- Copy the "declare once, generate daily, detect edits by hash" loop.
- But generate **route trips with seat inventory** and assign riders to seats. Don't run one search per rider.

### 3.2 Matching drivers to rides (on-demand) and scheduled feasibility

**How on-demand matching works:**
- A search becomes a scheduled job that broadcasts offers to batches of drivers. Default config ✓:
  - batch size 3;
  - at most 4 batches;
  - 120 seconds per batch;
  - 5 km radius;
  - at most 10 live offers per driver.
- Drivers accept (optionally adding a fare within limits) or reject.
- Ranking is not a fixed formula. A per-city rule set orders drivers using acceptance, cancellation, idle time, preference matches and other inputs.
- A per-driver cap on live offers exists because drivers holding many offers reject nearly all of them.

**How scheduled rides work:**
- Drivers can browse and claim upcoming bookings.
- The feasibility check refuses any booking it can't *prove* fits between the driver's other bookings, using 25 km/h for empty driving plus a buffer.

**For Kalisi:**
- Use **direct assignment** for planned duties, not broadcast. Keep broadcast only for filling gaps.
- Copy the "refuse unless provably feasible" check, but replace the flat 25 km/h with Hyderabad speeds by hour of day.

### 3.3 Fixed-route operations: stops, trips, seats, tickets and manifests

**How it works:**
- **Network model:**
  - `Station`, `Route` with polyline and return-route code;
  - `RouteTripStopMapping` keyed by trip × stop × day, with stop sequence and scheduled arrival and departure (`DA/spec/Storage/FRFSStaticData.yaml`);
  - service calendars by day of the week.
- **Fares:** matrix (origin–destination) or stage-based. Passenger categories include FEMALE and STUDENT.
- **Seats** ✓:
  - layouts with women-only flags and `minStopsRequired`;
  - holds per trip, seat and stretch of stops, set atomically with expiry;
  - a cleanup job releases expired holds every 2 minutes.
- **Tickets:**
  - the platform issues its own **digitally signed, rotating QR codes** (Ed25519);
  - conductors and drivers verify them through an API;
  - each scan records the vehicle.
- **Bus duties:**
  - a `TripTransaction` records driver and conductor badges, route, status, deviation count, and who started or ended the trip (driver, auto-detect or scheduled job);
  - the return trip can be assigned automatically ✓.
- **Manifests and notifications:**
  - riders are told when the trip starts and when the bus approaches their stop;
  - **the manifest includes riders' phone numbers** ✓ (see §1, point 10).
- **Live bus tracking:** the rider app reads positions and per-stop arrival times, each with a confidence level, from Redis keys that an **external** service writes.
- **The timetable (GTFS) server is external too** ("Nandi"). The repo only has its client.

**For Kalisi:**
- Key everything (fares, seat holds, manifests, arrival times, alerts) on **trip × stop sequence**.
- Copy the stretch-of-stops seat holds and the signed rotating QR.
- Minimise the manifest.
- Publish your own timetable and real-time feeds (GTFS / GTFS-RT) **from inside** the platform.

### 3.4 Location, distance and arrival times

**How it works:**
- **GPS quality:** points with accuracy of 50 m or worse are dropped.
- **Distance travelled:**
  - waypoints are buffered;
  - **snapping to roads runs only on triggers**: deviation, odd pickup or drop, tolls, or a mismatch at ride end;
  - otherwise the pre-planned route's distance is billed. This saves maps cost.
- **Deviation:** 3 consecutive points beyond a threshold.
- **Arrival alerts:** at 100 m and 40 m.
- **Pickup arrival time:** distance along the route ÷ a flat pickup speed, with a throttled re-fetch of the route.

**For Kalisi:** fixed routes make this cheaper still. Bill and track against the planned route, and investigate only deviations.

### 3.5 Fares

**How it works:**
- `FareProduct` (city × area × trip type × tier × time window) points to a fare policy.
- Fare types:
  - Progressive: base fare plus per-km and per-minute sections;
  - Slabs, Rental, InterCity, Ambulance.
- Add-ons: waiting, night, parking, stops, tolls, tips, a scheduling charge and a platform fee with CGST/SGST.
- Surge is a congestion multiplier from per-city rules. It can run in **shadow** mode first, and its version is pinned for each transaction.
- Tolls are detected by gate polygons and direction, then judged against GPS reliability.

**For Kalisi:** choose the fare by **route × time slot × tier**, pin the version once a rider has paid, and keep surge away from pass holders.

### 3.6 Money: subscriptions, mandates, ledgers and payouts

**How driver subscriptions work:**
- Plans have:
  - frequency: daily, weekly, monthly or flexible;
  - per-ride or flat pricing with a daily cap;
  - free rides or trial days;
  - a credit limit;
  - GST.
- **UPI AutoPay:**
  - when the mandate is set up, its cap is raised to cover any existing dues;
  - each debit gets a pre-debit notice, then execution;
  - retries, and a fallback to manual payment if the notice fails.
- **Above the credit limit**, the driver is unsubscribed and gets no rides ✓.

**The newer prepaid model** ✓:
- buying a plan credits a ride-credit account;
- each ride places a hold that is later settled or voided;
- credit is used oldest first;
- unused credit is booked as revenue on expiry.

**The ledger** (`LIB/finance-kernel`):
- double-entry and append-only;
- corrections are reversals, never edits;
- manual adjustments need one person to make them and another to approve;
- GST invoices, accounting-system export, and reconciliation against payment-gateway reports.

**Rider side:**
- **Payment gateways:** Juspay for passes and transit, Stripe for ride-hailing, Paytm card machines at booths.
- **Refunds:** issued per fare component, with an option to recover the amount from the driver.
- **Payouts:** drivers and fleet owners have their own ledger accounts, paid out on a schedule with a minimum amount.
- **Gaps:**
  - **passes have no AutoPay** ✓;
  - **no employer billing**. Only discounts by email domain (`DomainDiscountConfig`).

**For Kalisi:**
- Treat a monthly pass as **ride credit owed to the rider**, using the prepaid pattern.
- Build pass AutoPay on the driver-mandate pattern.
- Add an **EMPLOYER account** that can pay all or part of a pass.
- Pay operators through their own ledger accounts.

### 3.7 Safety

**How it works:**
- **SOS:**
  - creates a support ticket;
  - can alert police and stream the rider's location to the 112 emergency system (ERSS) ✓;
  - texts emergency contacts a tracking link;
  - an SOS outside a ride is tracked for 8 hours.
- **Rider safety settings:** night safety checks, auto-calling a contact, shake to activate, and practice SOS drills.
- **Cab safety checks:** route deviation and unusual stops trigger an automated call, then customer support, then police monitoring.
- **Bus alerts:** overspeeding, stopped, skipped or missed stops, wrong start, deviation, wrong direction, trip not started.
- **Calls and evidence:**
  - number-masked calls through Exotel;
  - drivers can upload ride evidence;
  - a check for whether a dashcam is installed.
- **Gaps:**
  - an SOS carries only `rideId` ✓, so a bus or shuttle SOS lacks trip and vehicle context;
  - I found **no server-side enforcement of women-only seats** (only in the dashboard's seat editor).

**For Kalisi:**
- Make SOS **trip-aware**: trip, vehicle, seat, driver and next stop.
- Connect to 112 (ERSS) from launch.
- Enforce women-only seats on the server.
- Send bus alerts to the control room and to affected riders.

### 3.8 Driver onboarding and verification

**How it works:**
- **Documents:** 60+ types, including licence, registration, permit, fitness, insurance, PUC (pollution certificate), police verification, medical and training.
- **Pluggable verification providers per city:** Idfy, HyperVerge, DigiLocker (OAuth with PKCE), MoRTH and others.
- **Identity:** selfie face-match against the document photo.
- **Background checks:**
  - licence numbers checked against a safety-portal suspect list, which can push new suspects by webhook;
  - court-record checks in the background.
- **Expiry:** reminders, then automatic suspension when a mandatory document expires.

**For Kalisi:** copy this nearly whole. Add the bus-specific documents: PSV badge, fitness certificate, contract-carriage permit and an AIS-140 tracker certificate.

### 3.9 Rules, behaviour and consequences

**How it works:**
- **Behaviour tracking:** rates over sliding time windows.
- **Rule engine:** turns those into consequences:
  - Nudge, Warn;
  - SoftBlock (per service tier), FeatureBlock;
  - HardBlock with cooldown, PermanentBlock;
  - ChargeFee, AssignTag.
- **Cancellation fault:** decided by rules over GPS evidence (distance covered, arrival, wait, calls, dark GPS time). This verdict is currently **advisory**.
- **Rewards:** coins and incentive journeys: daily, weekly or monthly milestones whose rewards can include subscription waivers or "pooling priority".

**For Kalisi:**
- Keep penalties as versioned, published rules.
- Log which rule decided each penalty.
- Give drivers a dispute window, which Namma Yatri already has.

### 3.10 Communication and complaints

**How it works:**
- **Messaging:** a rule-driven engine sends push, in-app overlay, SMS and badge messages.
- **WhatsApp booking bot:** six languages including **Telugu** ✓, with the script detected automatically. There is no Urdu.
- **Complaints:**
  - configurable issue trees with required uploads;
  - ONDC's grievance protocol (IGM): OPEN → ESCALATED → RESOLVED.
- **Open data:** the public dashboard is hosted elsewhere. There is no metrics endpoint in this repository.

**For Kalisi:** a WhatsApp channel in Telugu, Hindi and English (add Urdu) suits commuters and drivers.

---

## 4. What doesn't exist, which Kalisi must build

| Needed for Kalisi | What Namma Yatri has |
|---|---|
| Pooled seats in road trips; detour limits; matching riders to routes and stops | Exclusive rides only. `RideShare` is a category label. Seats exist only for transit tickets. |
| Network design: stop siting, route generation, duty chaining over a whole day | Single-booking feasibility checks; bus duties assigned by operators |
| Pass AutoPay; employer billing and sponsorship | One-off passes; email-domain discounts |
| Trip-aware SOS; minimal manifests | Ride-only SOS; manifest includes phone numbers |
| Per-stop arrival times, timetable data and real-time feeds inside the platform | External services (LTS, Nandi) |
| Mode-shift and evaluation data | Not a goal of the code |

---

## 5. Three ways to use this

1. **Pattern reuse** (recommended for the pilot). Build Kalisi on a lighter stack, borrowing the patterns marked above:
   - seat holds per stretch of stops;
   - signed rotating QR codes;
   - the feasibility check;
   - the prepaid ledger and mandates;
   - rules as published config;
   - idempotent message handling.

   No licence obligations attach to borrowing ideas.
2. **Plug into the open network.** List Kalisi shuttles as an **ONDC public-transport (FRFS) seller** in the `SHUTTLE` tier. Riders could then book through Namma Yatri or Mana Yatri, which already handle shuttle notifications and QR tickets, and through other ONDC apps.
   - This needs Kalisi to run an ONDC seller-side service.
   - It is the cheapest way to reach riders, and it fits the "open network" operating model in the design document.
3. **Fork the codebase.** This is possible but costly:
   - the AGPL licence requires publishing your modifications if you run them as a service (§13);
   - the stack is heavy;
   - essential pieces (location tracking, timetable server, shared kernel) live in other repositories you would also need to run.

   It makes sense mainly for a government-led model that intends to publish its code anyway.

**Also worth exploring:** Moving Tech (the operator of Namma Yatri) already works with the Telangana government on Mana Yatri. A pilot could approach them to operate the seller side or the bus-duty tooling.

---

## 6. Caveats

- **Production values aren't in the code.** Ranking rules, penalty rules, surge tables, fares and thresholds live in databases. Only development defaults are in the repo.
- **Seen in code is not the same as live.** These features exist in the code; whether they are switched on, and in which cities, is not visible.
- **Agent-led review.** Every finding cites files. I re-checked the ✓ items myself and the rest are traceable through their file references, but the review is not exhaustive. A developer should confirm anything you plan to build on.
- **The phone-number finding** describes data returned to *authenticated operator-side users*. It is a design choice to avoid, not evidence of a public leak.
