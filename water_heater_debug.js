/**
 * Shelly script to control water heater based on aWATTar spot price.
 * 
 * mJS script that fetches hourly electricity prices from aWATTar API, finds the cheapest time period, and sets Shelly schedules to turn on the heater during that period.
 */

const url = "https://api.awattar.at/v1/marketdata";
const period = 3;
const defaultstart = "0 1 12 * * SUN,MON,TUE,WED,THU,FRI,SAT";
const defaultend = "0 1 15 * * SUN,MON,TUE,WED,THU,FRI,SAT";
const max_avg_price = 999999;   // Eur/MWh above which the heater will not turn on, set to high value to always on
const NNEG = 56;
const SNAP = 44.8;
const PVP = 0.0001; // PV production in MWh
let SUMMER = false; // initialization, will be set in getTimezoneOffsetInSeconds()

// Random schedule around 18:00
let minrand = JSON.stringify(Math.floor(Math.random() * 15));
let secrand = JSON.stringify(Math.floor(Math.random() * 60));
let script_schedule = secrand + " " + minrand + " 18 * * SUN,MON,TUE,WED,THU,FRI,SAT";

// Read timezone offset ONCE at startup
let timezoneOffset = 3600; // fallback: UTC+1
let offset = getTimezoneOffsetInSeconds();
if (offset !== null) {
    timezoneOffset = offset;
}
console.log("=== Timezone offset: ", timezoneOffset, " ===");
console.log("=== SNAP SUMMER: ", SUMMER, " ===");


// --- FUNCTIONS ---

/**
 * Get timezone offset from current date and time.
 * Sets SUMMER flag for SNAP prices.
 * @returns {offset} timezone offset in seconds.
 */
function getTimezoneOffsetInSeconds() {
  // get current date and time
  const now = new Date();
  const str = now.toString();

  // check month for SNAP
  const month = now.getMonth(); // 0-11
  SUMMER = month >= 3 && month < 9 ? true : false;

  let offset = null;

  for (let i = 0; i < str.length; i++) {
    if ((str[i] === '+' || str[i] === '-') && i + 4 < str.length) {
      const sign = str[i] === '+' ? 1 : -1;
      const numStrHour = str.slice(i + 0, i + 3);
      const numStrMinute = str.slice(i + 3, i + 5);
      const hour = parseInt(numStrHour, 10);
      const minute = parseInt(numStrMinute, 10);
      offset = hour * 3600 + minute * 60 * sign;
      break;
    }
  }
  return offset;
}

/**
 * Returns the CET hour (0-23) for a given Unix timestamp.
 * @param {number} ts - Unix timestamp in milliseconds.
 * @returns {number} CET hour or -1 for invalid input.
 */
function getCETHour(ts) {
    if (typeof ts !== "number") return -1;
    let ms = normalizeUnixTimestamp(ts);
    let localMs = ms + timezoneOffset * 1000;
    return Math.floor(localMs / 3600000) % 24; // ms → hours, modulo 24 for CET hour
}

/**
 * Adds SNAP to market price.
 * @param {number} hour - CET hour (0-23).
 * @param {number} marketprice - Market price in Euro/MWh.
 * @returns {number} Adjusted price or -1 for invalid input.
 *
 * TODO only add SNAP from April to September
 */
function addSNAP(hour, marketprice) {
	if (
		hour == null 
		|| marketprice == null 
		|| typeof hour !== "number" 
		|| typeof marketprice !== "number"
		) return -1;
	const PVE = marketprice * PVP
	return hour >= 10 && hour < 16 ? marketprice + SNAP - PVE : marketprice + NNEG;
}

/**
 * Converts JSON data to an array of objects with CET hour and adjusted market price.
 * @param {Object} json - Input JSON with data array.
 * @returns {Array} Array of objects with cet_hour and marketprice.
 */
function toRowArray(json) {
    if (!json || !json.data) return [];
    let result = [];
    for (let k in json.data) {
        let v = json.data[k];
		let cet_hour = getCETHour(v.start_timestamp);
		let marketprice = SUMMER ? addSNAP(cet_hour, Number(v.marketprice)) : Number(v.marketprice);
        result.push({
            cet_hour: cet_hour,
            marketprice: marketprice,
        });
    }
    return result;
}

function normalizeUnixTimestamp(ts) {
    ts = Number(ts);
    if (ts > 1e12) {
        return ts;
    } else {
        return ts * 1000;
    }
}

function findCheapestPeriod(rows, period) {
    let len = rows.length;
    if (len < period) {
        console.log("=== Not enough data to find a ", period, "-hour period ===");
        return null;
    }

    let len_sum = len - period + 1;
    let movingSums = [];
    for (let i = 0; i < len_sum; i++) {
        let sum = 0;
        for (let j = i; j < i + period; j++) {
            sum += rows[j].marketprice;
        }
        movingSums.push(sum);
    }

    let minSum = movingSums[0];
    let minIndex = 0;
    for (let i = 1; i < movingSums.length; i++) {
        if (movingSums[i] < minSum) {
            minSum = movingSums[i];
            minIndex = i;
        }
    }

    return { minSum: minSum, minIndex: minIndex };
}

function find_cheapest(result) {
    //Timer.clear(keepAlive);

    if (!result || result.code !== 200) {
        console.log("=== HTTP request failed, using default schedule ===");
        updateSchedules(defaultstart, defaultend, true);
        return;
    }

    console.log("=== HTTP response received, finding cheapest hours ===");

    let data = JSON.parse(result.body);
    let rows = toRowArray(data);

    console.log("=== Rows found: ", rows.length, " ===");

    let cheapest = findCheapestPeriod(rows, period);

    if (!cheapest || rows.length === 0) {
        console.log("=== Not enough data, using default schedule ===");
        updateSchedules(defaultstart, defaultend, true);
        return;
    }

    let minIndex = cheapest.minIndex;
    let minSum = cheapest.minSum;
    let startHour = rows[minIndex].cet_hour;
    let endHour = rows[minIndex + period].cet_hour;
    let avgPrice = minSum / period;

    console.log("=== Cheapest start hour: ", startHour, " end hour: ", endHour, " avg price: ", avgPrice.toFixed(2), "Eur/MWh ===");

    let timespec = "0 0 " + JSON.stringify(startHour) + " * * SUN,MON,TUE,WED,THU,FRI,SAT";
    let offspec = "0 0 " + JSON.stringify(endHour) + " * * SUN,MON,TUE,WED,THU,FRI,SAT";

    let turn_on = true;
    if (avgPrice > max_avg_price) {
        console.log("=== Price too high, switch will not turn on ===");
        turn_on = false;
    }

    updateSchedules(timespec, offspec, turn_on);
}

function updateSchedules(timespec, offspec, turn_on) {
    console.log("=== Turn on schedule: ", timespec, " ===");
    console.log("=== Turn off schedule: ", offspec, " ===");
    console.log("=== Script schedule: ", script_schedule, " ===");
    console.log("=== All schedules created, stopping script ===");
}

async function updateTimer() {
    console.log("=== Fetching current price ===");

    try {
        const res = await fetch(url);
        const body = await res.text();
        find_cheapest({ code: res.status, body });
    } catch (err) {
        console.log("=== Fetch error, using default schedule ===", err);
        updateSchedules(defaultstart, defaultend, true);
    }
}


if (require.main === module) {
  updateTimer();
}