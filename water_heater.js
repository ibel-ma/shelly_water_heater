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

// Random schedule around 18:00
let minrand = JSON.stringify(Math.floor(Math.random() * 15));
let secrand = JSON.stringify(Math.floor(Math.random() * 60));
let script_schedule = secrand + " " + minrand + " 18 * * SUN,MON,TUE,WED,THU,FRI,SAT";

let script_number = Shelly.getCurrentScriptId();

// Read timezone offset ONCE at startup
let timezoneOffset = 3600; // fallback: UTC+1

// Keep-alive timer
let keepAlive = Timer.set(90 * 1000, false, function () {
    print("=== Timeout waiting for HTTP response, using defaults ===");
    updateSchedules(defaultstart, defaultend, true);
});


// --- FUNCTIONS ---

function getTimezoneOffsetInSeconds() {
  // get current date and time
  const now = new Date();
  const str = now.toString();

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

function normalizeUnixTimestamp(ts) {
    ts = Number(ts);
    if (ts > 1e12) {
        return ts;
    } else {
        return ts * 1000;
    }
}

function getCETHour(ts) {
    if (typeof ts !== "number") return -1;
    let ms = normalizeUnixTimestamp(ts);
    let localMs = ms + timezoneOffset * 1000;
    return Math.floor(localMs / 1000 / 60 / 60) % 24;
}

function toRowArray(json) {
    if (!json || !json.data) return [];
    let result = [];
    for (let k in json.data) {
        let v = json.data[k];
        result.push({
            cet_hour: getCETHour(v.start_timestamp),
            marketprice: Number(v.marketprice),
        });
    }
    return result;
}

function findCheapestPeriod(rows, period) {
    let len = rows.length;
    if (len < period) {
        print("=== Not enough data to find a ", period, "-hour period ===");
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
    Timer.clear(keepAlive);

    if (!result || result.code !== 200) {
        print("=== HTTP request failed, using default schedule ===");
        updateSchedules(defaultstart, defaultend, true);
        return;
    }

    print("=== HTTP response received, finding cheapest hours ===");

    let data = JSON.parse(result.body);
    let rows = toRowArray(data);

    print("=== Rows found: ", rows.length, " ===");

    let cheapest = findCheapestPeriod(rows, period);

    if (!cheapest || rows.length === 0) {
        print("=== Not enough data, using default schedule ===");
        updateSchedules(defaultstart, defaultend, true);
        return;
    }

    let minIndex = cheapest.minIndex;
    let minSum = cheapest.minSum;
    let startHour = rows[minIndex].cet_hour;
    let endHour = rows[minIndex + period].cet_hour;
    let avgPrice = minSum / period;

    print("=== Cheapest start hour: ", startHour, " end hour: ", endHour, " avg price: ", avgPrice.toFixed(2), "Eur/MWh ===");

    let timespec = "0 0 " + JSON.stringify(startHour) + " * * SUN,MON,TUE,WED,THU,FRI,SAT";
    let offspec = "0 0 " + JSON.stringify(endHour) + " * * SUN,MON,TUE,WED,THU,FRI,SAT";

    let turn_on = true;
    if (avgPrice > max_avg_price) {
        print("=== Price too high, switch will not turn on ===");
        turn_on = false;
    }

    updateSchedules(timespec, offspec, turn_on);
}

function updateSchedules(timespec, offspec, turn_on) {
    Shelly.call("Schedule.DeleteAll", {}, function () {

        print("=== Turn on schedule: ", timespec, " ===");
        Shelly.call("Schedule.Create", {
            "id": 0, "enable": true, "timespec": timespec,
            "calls": [{ "method": "Switch.Set", "params": { "id": 0, "on": turn_on } }]
        }, function () {

            print("=== Turn off schedule: ", offspec, " ===");
            Shelly.call("Schedule.Create", {
                "id": 0, "enable": true, "timespec": offspec,
                "calls": [{ "method": "Switch.Set", "params": { "id": 0, "on": false } }]
            }, function () {

                print("=== Script schedule: ", script_schedule, " ===");
                Shelly.call("Schedule.Create", {
                    "id": 3, "enable": true, "timespec": script_schedule,
                    "calls": [{ "method": "Script.start", "params": { "id": script_number } }]
                }, function () {
                    Timer.set(5 * 1000, false, function () {
                        print("=== All schedules created, stopping script ===");
                        Shelly.call("Script.stop", { "id": script_number });
                    });
                });
            });
        });
    });
}

function updateTimer() {
    print("=== Fetching current price ===");
    Shelly.call("HTTP.GET", { url: url, timeout: 60, ssl_ca: "*" }, find_cheapest);
}

// Read timezone offset ONCE at startup
let offset = getTimezoneOffsetInSeconds();
if (offset !== null) {
    timezoneOffset = offset;
}
print("=== Timezone offset: ", timezoneOffset, " ===");

updateTimer();