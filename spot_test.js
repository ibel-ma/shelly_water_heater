// Simple Node script to fetch the spot prices JSON
// Run with: node spot_test.js


const url = "https://api.awattar.at/v1/marketdata";

const period = 3; // number of consecutive hours to consider for finding the cheapest period


/**
 * find cheapest consecutive period in time series.
 *
 * This function calculates the moving sum of the `marketprice` values over the specified `rows` and finds the minimum sum and its index.
 * The length of moving sum is determined by the `period` parameter, which specifies how many consecutive hours to consider.
 *
 * @param {{cet_hour:number,marketprice:number}[]} row array
 * @param {number} period Number of consecutive hours to consider
 * @returns {{minSum:number,minIndex:number,movingSums:number[]}} Object containing the minimum sum and its index and the array of moving sums
 */
function findCheapestPeriod(rows, period) {
    const len = rows.length;
    if (len < period) {
        console.warn(`Not enough data to find a ${period}-hour period.`);
        return null;
    }
    // calculate moving sums of marketprice
    const len_sum = len - period + 1;
    const movingSums = new Array(len_sum).fill(0).map((_, i) =>
    rows.slice(i, i + period).reduce((sum, r) => sum + r.marketprice, 0)
    );

    // find index of minimum sum
    const minSum = Math.min(...movingSums);
    const minIndex = movingSums.indexOf(minSum);

    return { minSum, minIndex, movingSums };
}

/**
 * Convert a Unix timestamp into the CET hour (0-23).
 *
 * The API values are sometimes in milliseconds and sometimes in seconds; this
 * function treats both correctly by using JavaScript Date semantics.
 *
 * @param {number} tsSeconds Unix timestamp in seconds or milliseconds
 * @returns {number} CET hour (0-23) or NaN if the input is invalid
 */
function getCETHour(tsSeconds) {
  if (typeof tsSeconds !== "number") return NaN;
  const date = new Date(normalizeUnixTimestamp(tsSeconds));
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris",
    hour: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const hourPart = parts.find((p) => p.type === "hour");
  return hourPart ? parseInt(hourPart.value, 10) : NaN;
}

/**
 * Convert the raw API JSON into a simple array of rows.
 *
 * Each row contains:
 *   - `cet_hour` (hour of day in CET)
 *   - `marketprice` (numeric)
 *
 * @param {object} json API response object
 * @returns {{cet_hour:number,marketprice:number}[]} row array
 */
function toRowArray(json) {
  if (!json || !json.data) return [];
  return Object.entries(json.data).map(([k, v]) => ({
    cet_hour: getCETHour(v.start_timestamp),
    marketprice: Number(v.marketprice),
  }));
}

/**
 * Normalizes Unix timestamps to ms.
 *
 * The API values are sometimes in milliseconds and sometimes in seconds; this
 * function converts both to ms.
 * Very old dates (pre-1970) or far future timestamps can overlap ranges.
 *
 * @param {number} tsSeconds Unix timestamp in seconds or milliseconds
 * @returns {string} CET time format (yyyy-MM-dd HH:mm:ss+offset) or NaN if the input is invalid
 */
function normalizeUnixTimestamp(ts) {
  ts = Number(ts);
  if (ts > 1e12) {        // likely ms
    return ts;
  } else {                // likely s
    return Number(ts * 1000);
  }
}


/**
 * Convert a Unix timestamp into the CET time format.
 *
 * The API values are sometimes in milliseconds and sometimes in seconds; this
 * function treats both correctly by using JavaScript Date semantics.
 *
 * @param {number} tsSeconds Unix timestamp in seconds or milliseconds
 * @returns {string} CET time format (yyyy-MM-dd HH:mm:ss+offset) or NaN if the input is invalid
 */
function formatCET(tsSeconds) {
  const date = new Date(normalizeUnixTimestamp(tsSeconds));
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "shortOffset",
  });

  const parts = fmt.formatToParts(date);
  const partMap = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const dateStr = `${partMap.year}-${partMap.month}-${partMap.day} ${partMap.hour}:${partMap.minute}:${partMap.second}`;

  const tz = partMap.timeZoneName || "";
  const offsetMatch = tz.match(/GMT([+-]\d{1,2})/);
  const offset = offsetMatch ? `${offsetMatch[1].padStart(3, "0")}:00` : "";

  return `${dateStr}${offset ? offset : ""}`;
}


/**
 * Fetches the current electricity price.
 * 
 * This function makes an HTTP GET request to the specified URL and returns the parsed JSON data.
 *
 * @param {string} some_url The URL to fetch the electricity price from
 * @returns {Promise} A promise resolving to the current price or an error.
 */
function getCurrentPrice(some_url) {
  Shelly.call(
    "http.get",
    {
      url: url,
    },
    function (response, error_code, error_message) {
      if (error_code !== 0) {
        print(error_message);
        // If fetching prices fails, use default schedule
        // updateSchedules(defaultstart, defaultend, true);
        return;
      }
      //let data = JSON.parse(response.body);
      return response;
    }
  );
}


async function main() {
  // fetch data
  console.log("Fetching", url);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  
  // parse JSON
  const data = await res.json();

  /*
  console.log("\n=== Raw JSON (pretty) ===\n");
  console.log(JSON.stringify(data, null, 2));
  */

  // print table
  console.log("\n=== hourly_prices (table view) ===\n");
  console.table(Object.entries(data.data).map(([k, v]) => ({
    key: k,
    start_timestamp: v.start_timestamp,
    start_cet: v.start_timestamp ? getCETHour(v.start_timestamp) : "",
    end_timestamp: v.end_timestamp,
    marketprice: v.marketprice,
    unit: v.unit
  })));
  
  // convert to row array
  const rows = toRowArray(data);
  // rows is now an array like:
  // [ { cet_hour: 20, marketprice: 150.27 }, ... ]

  // get cheapest period
  const { minSum, minIndex, movingSums } = findCheapestPeriod(rows, period);
  console.log(`\n=== minimum sum of ${period} consecutive hours is ${minSum.toFixed(2)} at index ${minIndex} (hours ${rows[minIndex].cet_hour} to ${rows[minIndex + period - 1].cet_hour}) ===\n`);


    // print table
  console.log("\n=== moving_sums (table view) ===\n");
  console.table(Object.entries(movingSums).map(([k, v]) => ({
    key: k,
    start_timestamp: v
  })));
}


if (require.main === module) {
  main().catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  });
}
