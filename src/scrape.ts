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

(async () => {
  try {
    const browser = await chromium.launch({
      headless: true, // TODO: change back to process.env.NODE_ENV !== 'development'
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--no-sandbox',
      ]
    });

    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      locale: 'en-US',
      timezoneId: 'America/Denver',
    });

    const page = await context.newPage();

    const url = `https://kananaskisabresidents.cps.golf/onlineresweb/search-teetime?TeeOffTimeMin=${config.startTime}&TeeOffTimeMax=${config.endTime}`;
    await page.goto(url);
    await page.waitForTimeout(5000);

    // Navigate to first date using calendar
    const [targetYear, targetMonth, targetDay] = config.dates[0].split('-').map(Number);

    console.log(`[${getMSTTimestamp()}] Navigating to ${targetMonth}/${targetDay}/${targetYear}`);

    // Navigate to correct month
    let currentMonth = 5; // May (current month from snapshot)
    let currentYear = 2026;

    while (currentYear < targetYear || (currentYear === targetYear && currentMonth < targetMonth)) {
      console.log(`[${getMSTTimestamp()}] Calendar at ${currentMonth}/${currentYear}, navigating to ${targetMonth}/${targetYear}`);
      // Click next month button (it's the 4th button: [0]=disabled prev, [1]=month selector, [2]=Sign In, [3]=next)
      const buttons = await page.$$('button');
      if (buttons.length > 3) {
        await buttons[3].click();
      }
      await page.waitForTimeout(1000);
      currentMonth++;
      if (currentMonth > 12) {
        currentMonth = 1;
        currentYear++;
      }
    }

    console.log(`[${getMSTTimestamp()}] Calendar navigation complete, now at ${currentMonth}/${currentYear}`);
    await page.waitForTimeout(3000);

    // Click day in calendar grid
    try {
      await page.click(`text="${targetDay}"`, { timeout: 5000 });
      console.log(`[${getMSTTimestamp()}] Clicked day ${targetDay}`);
    } catch (err) {
      console.log(`[${getMSTTimestamp()}] ERROR: Could not click day ${targetDay}`);
      await page.screenshot({ path: '/tmp/calendar-error.png', fullPage: true });
      await browser.close();
      process.exit(1);
    }

    await page.waitForTimeout(1000);

    // Select golfers
    const golfersButtonText = config.golfers === 1 ? "Any" : config.golfers.toString();
    await page.click(`button:has-text("${golfersButtonText}")`);
    await page.waitForTimeout(1000);

    const daysToQuery = config.dates.map((dateStr) => {
      const [year, month, day] = dateStr.split('-').map(Number);
      const date = new Date(year, month - 1, day);
      return {
        date: date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }),
        dateValue: `${month}/${day}/${year % 100}`,
        lastResults: [] as string[],
      };
    });

    while (true) {
      let emailBody = "";
      let shouldSendEmail = false;

      for (const dayConfig of daysToQuery) {
        // Click the specific day in calendar
        const [month, day, year] = dayConfig.dateValue.split('/').map(Number);

        try {
          await page.click(`text="${day}"`, { timeout: 5000 });
        } catch (err) {
          console.log(`[${getMSTTimestamp()}] WARNING: Could not click day ${day} for ${dayConfig.date}`);
        }

        await page.waitForTimeout(3000);

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
            to: ["brocklchelle@gmail.com"],
            subject: "Kananaskis Tee Times",
            text: emailBody,
          });
          console.log(`[${getMSTTimestamp()}] Email sent`);
        } catch (err) {
          console.error(`[${getMSTTimestamp()}] Email failed:`, err);
        }
      }

      await page.waitForTimeout(30000);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;

    console.error(`[${getMSTTimestamp()}] CRASH:`, errorMessage);
    if (errorStack) console.error(errorStack);

    try {
      await resend.emails.send({
        from: 'Kananaskis Tee Times <onboarding@resend.dev>',
        to: ["brocklchelle@gmail.com"],
        subject: "Kananaskis Scraper Crashed",
        text: `Script crashed at ${getMSTTimestamp()}\n\nError: ${errorMessage}\n\n${errorStack || 'No stack trace'}`,
      });
      console.log(`[${getMSTTimestamp()}] Crash email sent`);
    } catch (emailErr) {
      console.error(`[${getMSTTimestamp()}] Failed to send crash email:`, emailErr);
    }

    process.exit(1);
  }
})();
