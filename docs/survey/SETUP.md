# Kalisi demo: switching on Google address search

> **Hosting on the Kalisi server (contabo1):** the demo is published at `https://<address>/demo/` (and `/demo/presenter.html`). To switch on Google address search there, set `GOOGLE_MAPS_API_KEY` in `deploy/contabo1/.env`, restrict the key to `https://<address>/*`, and re-run the installer.

This folder holds two copies of the same demo:

- **`index.html`:** the clean version to share, with no presenter notes or demo controls.
- **`presenter.html`:** for presenting, with talking points, sources, scenario shortcuts and trip-simulation controls.

Paste your API key into each file you host (step 2).

The address search in both can work in two ways:

| Mode | When it's used | Address search | Pin map |
|---|---|---|---|
| **Built-in** | No API key, or Google fails to load | About 11,450 Hyderabad places and streets from OpenStreetMap, embedded in the page; works offline; nothing is sent anywhere | Street map drawn from OpenStreetMap roads |
| **Google** | You paste a Google Maps API key and host the file on your own website | Google Places autocomplete (exact addresses, buildings, businesses) | Google map |

The Claude link can't use Google mode. Claude-hosted pages may only load scripts from a short list of approved code hosts, and `maps.googleapis.com` isn't on it. That's why Google mode needs your own hosting.

## 1. Create and restrict an API key (about 15 minutes)

1. Open the Google Cloud console, create a project (for example `kalisi-demo`) and attach a billing account. Google requires billing even for usage inside the free tier.
2. Under **APIs & Services → Library**, enable:
   - **Maps JavaScript API** (loads the map and libraries);
   - **Places API (New)** (the autocomplete suggestions and place details);
   - **Geocoding API** (optional: names the spot when someone drags the pin; without it the pin still works and shows coordinates).
3. Under **APIs & Services → Credentials**, create an **API key**, then restrict it:
   - **Application restrictions → Websites:** add the exact address where you will host the demo, e.g. `https://yourorg.github.io/*`.
   - **API restrictions:** allow only the three APIs above.

   A browser key is visible to anyone who opens the page. These restrictions stop it being reused elsewhere.

## 2. Paste the key

Open `index.html` in a text editor and find this line (search for `GOOGLE_MAPS_API_KEY`):

```js
const GOOGLE_MAPS_API_KEY = '';   // <-- paste your browser API key between the quotes
```

Put the key between the quotes and save.

## 3. Host it

Any static web host works, as long as the address matches the website restriction on the key:

- **GitHub Pages:** create a repository, upload `index.html`, then turn on Pages under **Settings → Pages**.
- **Netlify Drop or Cloudflare Pages:** drag the folder in.
- **Your organisation's website:** upload it as a static page.

Opening the file straight from your computer (`file://`) will not match a website-restricted key. Use the hosted address.

## 4. Check it worked

Open the hosted page and go to **Your commute**. The presenter notes should say **"Address search: Google Places"**.

If they say **"Google isn't working here"**, the note gives the reason. The usual causes are:
- the key isn't pasted;
- the website restriction doesn't match the address you opened;
- Places API (New) isn't enabled;
- billing isn't attached.

The demo falls back to built-in search automatically, so a presentation never breaks.

## What it costs

Google's India price list puts the services the demo uses in the **Essentials** tier. Each has a **free usage allowance of 70,000 per month** for India-billed accounts:
- Dynamic Maps;
- Autocomplete Requests;
- Place Details Essentials;
- Geocoding.

Autocomplete Session Usage is listed as **unlimited**. Source: Google Maps Platform, *Pricing for India* (developers.google.com/maps/billing-and-pricing/pricing-india), checked 27 Oct 2026.

A demo used by a few people will very likely stay inside the free allowance.

To keep costs down, the demo:
- uses **session tokens**, which group a search and its selection into one billing session;
- requests only the `formattedAddress` and `location` fields.

I did not verify which billing item each field falls under. Check the billing report after your first day of use.

## Rules to know before wider use

- **Google results shown on a map must be on a Google map.** Google's Places API policies say this. In Google mode the pin map is a Google map. The small schematic route maps elsewhere in the demo are not. Before any public launch, switch those to Google maps, or don't plot Google-sourced locations on them.
- **Show the Google logo.** When Places results appear without a map, Google's policies require its logo. The demo shows the text "Powered by Google". Replace it with Google's official logo asset before any public use.
- **Tell users about Google in the privacy notice.** In Google mode, what people type and the addresses they pick are sent to Google. The privacy notice (the consent screen) should name Google as a service provider. Built-in mode sends nothing anywhere.

## Built-in mode data

- **Places, streets and roads:** © OpenStreetMap contributors, available under the Open Database License (ODbL). The extract is dated 27 Oct 2026 and covers roughly the Outer Ring Road area plus some margin.
- **Coverage is good but not complete.** Many gated communities, IT parks and streets are in it. Individual house numbers mostly aren't, which is why the pin and the "Flat, floor and building" field exist.
- **Metro stations** come from the HMRL timetable feed (Open Data Telangana, July 2026).
