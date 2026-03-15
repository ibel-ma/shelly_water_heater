# Shelly aWATTar Spot Price Controller

A script for Shelly smart switches that automatically schedules a connected device (e.g. a water heater) to run during the **cheapest electricity hours** of the day, based on the [aWATTar](https://www.awattar.at) real-time spot price API.

---

## Purpose

Electricity spot prices vary by the hour. This script fetches today's hourly prices each evening, finds the cheapest consecutive block of hours, and programs the Shelly switch to turn on and off automatically at the optimal times — saving money without any manual intervention.

---

## Requirements

- A **Shelly device** with scripting support (e.g. Shelly Plus, Shelly Pro series)
- Firmware with mJS scripting enabled
- The Shelly must be **connected to the internet** to reach the aWATTar API
- An **aWATTar electricity tariff** (Austria) — the API is free and public, but the spot price benefit only applies if your tariff is indexed to the spot price
- The Shelly's **timezone must be configured correctly** in the device settings, so that DST (daylight saving time) is handled automatically

---

## How It Works

### Overview

```
Every evening at ~18:00
        │
        ▼
Fetch hourly prices from aWATTar API
        │
        ▼
Find cheapest N consecutive hours
        │
        ▼
Create Shelly schedules for ON and OFF
        │
        ▼
Stop script (schedules run independently)
```

### Step by Step

1. **Startup (~18:00):** The script is triggered by a Shelly schedule once per day, shortly after 18:00. A random offset (0–15 min, random seconds) is used to avoid all clients hitting the API at exactly the same time.

2. **Fetch prices:** An HTTP GET request is sent to `https://api.awattar.at/v1/marketdata`, which returns hourly spot prices in UTC Unix timestamps.

3. **Find cheapest period:** The script calculates a moving sum over all consecutive windows of `period` hours and finds the window with the lowest total price.

4. **Update schedules:** All existing Shelly schedules are deleted and three new ones are created:
   - **Turn ON** at the start of the cheapest period
   - **Turn OFF** at the end of the cheapest period
   - **Run this script again** the next evening at ~18:00

5. **Stop:** The script stops itself 5 seconds after the schedules are created. The schedules then run independently without the script needing to be active.

---

## Configuration

At the top of the script, the following constants can be adjusted:

| Variable | Default | Description |
|---|---|---|
| `period` | `3` | Number of cheapest consecutive hours to find |
| `defaultstart` | `"0 1 9 * * ..."` | Fallback ON time if API fetch fails (crontab) |
| `defaultend` | `"0 1 11 * * ..."` | Fallback OFF time if API fetch fails (crontab) |
| `max_avg_price` | `999999` | Maximum average price (EUR/MWh) to allow switch-on. Set lower to prevent running when prices are very high. |

### Price Units

The `max_avg_price` is in **EUR per MWh**, excluding taxes.  
Example: if you want to cap at 10 ct/kWh → use `100`.

---

## Timezone & Daylight Saving Time

The aWATTar API returns timestamps in UTC. The script reads the **timezone offset directly from the Shelly device** at startup:

```javascript
let sys = Shelly.getComponentStatus("sys");
timezoneOffset = sys.offset; // e.g. 3600 in winter, 7200 in summer
```

This means DST is handled **automatically**, as long as the Shelly's timezone is set correctly in its settings. No manual adjustment is needed when clocks change.

---

## Fallback Behavior

If the API request fails (network error, timeout, or non-200 response), the script falls back to the default schedule defined by `defaultstart` and `defaultend`. This ensures the device still runs at a reasonable time even without internet access.

---

## mJS Compatibility

Shelly devices run **mJS**, a minimal JavaScript engine designed for microcontrollers. It does **not** support many standard JS features. This script is written to be fully compatible with mJS:

| Standard JS Feature | mJS Alternative Used |
|---|---|
| `Object.entries()` | `for...in` loop |
| `.map()`, `.reduce()`, `.filter()` | Plain `for` loops |
| `Math.min(...array)` | Manual min loop |
| `Intl.DateTimeFormat` | UTC math with device offset |
| Template literals `` `${x}` `` | String concatenation |
| `Array.prototype.find()` | Manual loop |

All `Shelly.call()` operations that depend on each other are **nested in callbacks** to ensure correct execution order, since mJS is single-threaded and async.

---

## Schedule Format

Schedules use **crontab format** with seconds prepended:

```
second minute hour day month weekday
```

Example: `0 0 10 * * SUN,MON,TUE,WED,THU,FRI,SAT` → triggers at 10:00:00 every day.

You can inspect active schedules via the Shelly RPC interface:

```
http://<shelly-ip>/rpc/Schedule.List
```

---

## Installation

1. Open the Shelly web interface
2. Go to **Scripts** → **Add Script**
3. Paste the script content
4. Save and **Run** the script once manually to create the initial schedules
5. The script will then self-schedule and run automatically every evening at ~18:00

---

## Debugging

The script prints status messages to the console at each step:

```
=== Timezone offset:  3600  ===
=== Fetching current price ===
=== HTTP response received, finding cheapest hours ===
=== Rows found:  24  ===
=== Cheapest start hour:  10  end hour:  13  avg price:  28.06  ===
=== Turn on schedule:  0 0 10 * * SUN,MON,TUE,WED,THU,FRI,SAT  ===
=== Turn off schedule:  0 0 13 * * SUN,MON,TUE,WED,THU,FRI,SAT  ===
=== Script schedule:  37 6 18 * * SUN,MON,TUE,WED,THU,FRI,SAT  ===
=== All schedules created, stopping script ===
```

If the output stops after `=== Fetching current price ===`, the HTTP request is not completing — check network connectivity and that the aWATTar API is reachable from the device.