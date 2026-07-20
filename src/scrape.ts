import dotenv from "dotenv";
dotenv.config();

import { chromium } from "playwright-extra";
import stealth from "puppeteer-extra-plugin-stealth";
import { Resend } from "resend";

chromium.use(stealth());

const resend = new Resend(process.env.RESEND_API_KEY!);

// Parse CLI args
function parseArgs() {
  const args = process.argv.slice(2);
  const params: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      params[key] = args[++i];
    }
  }

  const dates = params["dates"];
  const startTime = params["start-time"];
  const endTime = params["end-time"];
  const golfers = params["golfers"];

  if (!dates || !startTime || !endTime || !golfers) {
    console.error("Missing required parameters.");
    console.error("Usage: npx ts-node src/scrape.ts --dates <YYYY-MM-DD,YYYY-MM-DD> --start-time <hour> --end-time <hour> --golfers <1-4>");
    process.exit(1);
  }

  return {
    dates: dates.split(","),
    startTime: parseInt(startTime),
    endTime: parseInt(endTime),
    golfers: parseInt(golfers)
  };
}

const config = parseArgs();

// Helper to get MST timestamp
function getMSTTimestamp() {
  const now = new Date();
  // MST is UTC-7, no DST
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const mst = new Date(utc - 6 * 60 * 60000);
  return mst.toISOString().replace("T", " ").substring(0, 19) + " MST";
}

// Selects a date via the inline calendar widget. The date <input> is readonly and
// sits behind an overlay (Playwright can't click it), the day number lives in a
// sibling span (not the button), two calendars exist in the DOM (one hidden), and
// adjacent-month cells duplicate day numbers. So we drive it through evaluate on the
// visible calendar: page months by clicking next to the title, then click the day at
// (firstOne + day - 1) since the first "1" is always the current month's day one.
async function selectDate(page: any, month: number, day: number, year: number) {
  const target = new Date(year, month - 1, 1).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });

  for (let i = 0; i < 24; i++) {
    const state = await page.evaluate((target: string) => {
      const cal = [...document.querySelectorAll(".ngx-dates-picker-calendar-container")]
        .find((c) => (c as HTMLElement).offsetWidth || (c as HTMLElement).offsetHeight);
      if (!cal) return "nocal";
      const title = cal.querySelector(".topbar-title") as HTMLElement;
      if (title.textContent?.trim() === target) return "done";
      (title.nextElementSibling as HTMLElement).click();
      return "nav";
    }, target);
    if (state === "done") break;
    if (state === "nocal") throw new Error("calendar not visible");
    await page.waitForTimeout(300);
  }

  const clicked = await page.evaluate((day: number) => {
    const cal = [...document.querySelectorAll(".ngx-dates-picker-calendar-container")]
      .find((c) => (c as HTMLElement).offsetWidth || (c as HTMLElement).offsetHeight);
    if (!cal) return null;
    const units = [...cal.querySelectorAll(".day-unit")] as HTMLElement[];
    const firstOne = units.findIndex((u) => u.textContent?.trim() === "1");
    const cell = units[firstOne + day - 1];
    if (!cell) return null;
    ((cell.querySelector("button") as HTMLElement) || cell).click();
    return cell.textContent?.trim();
  }, day);
  if (!clicked) throw new Error("day cell not found");
}

let consecutiveFailures = 0;

async function runBrowser() {
  // Persistent profile so a solved cf_clearance cookie survives restarts; real Chrome (not
  // bundled Chromium) drops a batch of automation fingerprint tells.
  const context = await chromium.launchPersistentContext(".chrome-profile", {
    channel: "chrome",
    headless: process.env.NODE_ENV !== 'development',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--no-sandbox',
    ],
    proxy: {
      server: 'http://pr.oxylabs.io:7777',
      // sticky session pins the exit IP so a solved cf_clearance cookie stays valid
      username: 'customer-blchelle-cc-CA-sessid-kananaskis-sesstime-30',
      password: process.env.OXYLABS_PASSWORD!,
    },
    viewport: { width: 1920, height: 1080 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'America/Denver',
  });

  try {
    const page = context.pages()[0] ?? await context.newPage();

    const url = `https://kananaskisabresidents.cps.golf/onlineresweb/search-teetime?TeeOffTimeMin=${config.startTime}&TeeOffTimeMax=${config.endTime}`;
    await page.goto(url);
    await page.waitForTimeout(5000);

    // Select golfers
    const golfersButtonText = config.golfers === 1 ? "Any" : config.golfers.toString();
    try {
      await page.click(`button:has-text("${golfersButtonText}")`);
    } catch (err) {
      // ponytail: diagnostic only — capture page state so we can see WHY the button is missing
      const buttons = await page.$$eval("button", (bs) =>
        bs.map((b) => b.textContent?.trim()).filter(Boolean)
      ).catch(() => []);
      await page.screenshot({ path: "golfers-fail.png", fullPage: true }).catch(() => {});
      console.error(`[${getMSTTimestamp()}] Golfers click failed. url=${page.url()} title="${await page.title().catch(() => "")}"`);
      console.error(`[${getMSTTimestamp()}] Buttons on page (${buttons.length}): ${JSON.stringify(buttons)}`);
      throw err;
    }
    await page.waitForTimeout(1000);

    const daysToQuery = config.dates.map((dateStr) => {
      const [year, month, day] = dateStr.split('-').map(Number);
      const date = new Date(year, month - 1, day);
      return {
        date: date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }),
        month,
        day,
        year,
        lastResults: [] as string[],
      };
    });

    while (true) {
      let emailBody = "";
      let shouldSendEmail = false;

      for (const dayConfig of daysToQuery) {
        try {
          await selectDate(page, dayConfig.month, dayConfig.day, dayConfig.year);
        } catch (err) {
          console.log(`[${getMSTTimestamp()}] WARNING: Could not select ${dayConfig.date}`);
          continue;
        }

        await page.waitForTimeout(4000);

        // Parse all results
        const allResults = await page.$$eval("button.btn-teesheet", (buttons) => {
          return buttons
            .filter((btn) => {
              const timer = btn.querySelector("time[role='timer']");
              const course = btn.querySelector("li");
              return timer && course;
            })
            .map((btn) => {
              const timer = btn.querySelector("time[role='timer']");
              const course = btn.querySelector("li");
              const detailsText = btn.textContent || "";

              // Get time and AM/PM labels
              const timeText = timer?.textContent?.trim() || "";
              const labels = Array.from(timer?.parentElement?.querySelectorAll('label') || [])
                .map(l => l.textContent?.trim())
                .join('');

              const time = timeText + labels; // e.g., "8:15AM"
              const courseName = course?.textContent?.trim() || "";

              return { time, course: courseName, details: detailsText };
            });
        });

        // Filter results based on time and golfers
        const results = allResults.filter(({ time, details }) => {
          // Parse time (format: "8:15AM" or "2:24PM")
          const timeMatch = time.match(/(\d+):(\d+)\s*([AP])M?/);
          if (!timeMatch) return false;

          let hour = parseInt(timeMatch[1]);
          const period = timeMatch[3];

          if (period === 'P' && hour !== 12) hour += 12;
          if (period === 'A' && hour === 12) hour = 0;

          // Check time range
          if (hour < config.startTime || hour >= config.endTime) return false;

          // Check golfers - skip if specific count and doesn't match
          if (config.golfers > 1) {
            const golfersMatch = details.match(/(\d+)\s*(?:-\s*(\d+))?\s*GOLFERS?/i);
            if (golfersMatch) {
              const minGolfers = parseInt(golfersMatch[1]);
              const maxGolfers = golfersMatch[2] ? parseInt(golfersMatch[2]) : minGolfers;

              // Only include if our golfer count fits in range
              if (config.golfers < minGolfers || config.golfers > maxGolfers) return false;
            }
          }

          return true;
        });

        const uniqueResultsSet = new Set<string>();
        const uniqueResults = results.filter(({ time, course }) => {
          const key = `${time} | ${course}`;
          if (uniqueResultsSet.has(key)) return false;
          uniqueResultsSet.add(key);
          return true;
        });

        const currentResults = uniqueResults.map(
          ({ time, course }) => `${time} | ${course}`
        );

        const newResults = currentResults.filter(
          (r) => !dayConfig.lastResults.includes(r)
        );

        if (results.length === 0) {
          console.log(
            `[${getMSTTimestamp()}] No tee times found for ${dayConfig.date}`
          );
        } else if (newResults.length > 0) {
          console.log(`[${getMSTTimestamp()}] New tee times for ${dayConfig.date}`);
          newResults.forEach((r) =>
            console.log(`[${getMSTTimestamp()}] ${r}`)
          );
          emailBody +=
            `New tee times for ${dayConfig.date}:\n` +
            newResults.map((r) => r).join("\n") +
            "\n";
          shouldSendEmail = true;
        } else {
          console.log(
            `[${getMSTTimestamp()}] No new tee times for ${dayConfig.date}`
          );
        }

        dayConfig.lastResults = currentResults;
      }

      if (shouldSendEmail) {
        try {
          await resend.emails.send({
            from: 'Kananaskis Tee Times <onboarding@resend.dev>',
            to: ["brocklchelle@gmail.com", "sth.marzolf@live.com", "ryanalcock99@gmail.com", "dclark@ualberta.ca"],
            subject: "Kananaskis Tee Times",
            text: emailBody,
          });
          console.log(`[${getMSTTimestamp()}] Email sent`);
        } catch (err) {
          console.error(`[${getMSTTimestamp()}] Email failed:`, err);
        }
      }

      consecutiveFailures = 0;
      await page.waitForTimeout(30000);
    }
  } finally {
    await context.close().catch(() => {});
  }
}

// A closed page/browser is a transient blip for a scraper meant to run forever,
// so relaunch instead of dying. Only email + exit if it keeps failing back-to-back.
(async () => {
  while (true) {
    try {
      await runBrowser();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;

      consecutiveFailures++;
      console.error(`[${getMSTTimestamp()}] CRASH (${consecutiveFailures}):`, errorMessage);
      if (errorStack) console.error(errorStack);

      if (consecutiveFailures < 5) {
        await new Promise((r) => setTimeout(r, 60000));
        continue;
      }

      try {
        await resend.emails.send({
          from: 'Kananaskis Tee Times <onboarding@resend.dev>',
          to: ["brocklchelle@gmail.com"],
          subject: "Kananaskis Scraper Crashed",
          text: `Script crashed ${consecutiveFailures}x at ${getMSTTimestamp()}\n\nError: ${errorMessage}\n\n${errorStack || 'No stack trace'}`,
        });
        console.log(`[${getMSTTimestamp()}] Crash email sent`);
      } catch (emailErr) {
        console.error(`[${getMSTTimestamp()}] Failed to send crash email:`, emailErr);
      }

      process.exit(1);
    }
  }
})();
