import dotenv from "dotenv";
dotenv.config();

import { chromium } from "playwright";
import sgMail from "@sendgrid/mail";

sgMail.setApiKey(process.env.SENDGRID_API_KEY!);

// Helper to get MST timestamp
function getMSTTimestamp() {
  const now = new Date();
  // MST is UTC-7, no DST
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const mst = new Date(utc - 6 * 60 * 60000);
  return mst.toISOString().replace("T", " ").substring(0, 19) + " MST";
}

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1300, height: 900 },
  });
  const page = await context.newPage();

  // Construct the search URL
  const url = `https://kananaskisabresidents.cps.golf/onlineresweb/search-teetime?TeeOffTimeMin=0&TeeOffTimeMax=17`;
  await page.goto(url);

  // Step 1: Ensure the calendar is set to July 2025
  let topbarText = await page.textContent(".topbar-container .topbar-title");
  let tries = 0;
  while (topbarText?.trim() !== "July 2025" && tries < 12) {
    const nextBtn = (await page.$$(".topbar-container .ng-star-inserted"))[1];
    if (nextBtn) {
      await nextBtn.click();
    }
    await page.waitForTimeout(500);
    topbarText = await page.textContent(".topbar-container .topbar-title");
    tries++;
  }

  // Define configs for both July 11th and July 12th
  const daysToQuery = [
    {
      date: "July 11th, 2025",
      selector: "div.day-unit:nth-child(13)",
      lastResults: [] as string[],
    },
    {
      date: "July 12th, 2025",
      selector: "div.day-unit:nth-child(14)",
      lastResults: [] as string[],
    },
  ];

  // Initial click to set to July 12th (default)
  await page.click(daysToQuery[1].selector);
  await page.waitForTimeout(500);

  // Step 3: Click the 18 holes toggle and start polling loop
  const toggleButtons = await page.$$(
    ".mat-button-toggle-group .mat-button-toggle-button"
  );
  // Initial click on the 3rd button (4 players)
  await toggleButtons[2].click();

  await page.waitForTimeout(500);
  // Neverending polling loop, iterate over dayConfigs
  while (true) {
    let emailBody = "";
    let shouldSendEmail = false;
    for (const config of daysToQuery) {
      // Click the correct day
      await page.click(config.selector);
      await page.waitForTimeout(500);
      // 1. Attempt to read results
      try {
        await page.waitForSelector(".mat-card-content", { timeout: 10000 });
      } catch {
        // No results found, continue
      }
      const results = await page.$$eval(".mat-card-content", (cards) => {
        return cards.map((card) => {
          const timeElem = card.querySelector(
            ".teetimetableDateTime.time-teetime-table"
          ) as HTMLElement;
          const courseElem = card.querySelector(
            ".teetimecourseshort.ng-star-inserted"
          ) as HTMLElement;
          // Clean up whitespace and join lines for time and course
          const time = timeElem
            ? timeElem.innerText.replace(/\s+/g, " ").trim()
            : "";
          const course = courseElem
            ? courseElem.innerText.replace(/\s+/g, " ").trim()
            : "";
          return { time, course };
        });
      });
      // Deduplicate by both time and course
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
      // Only send email if there is a new result
      const newResults = currentResults.filter(
        (r) => !config.lastResults.includes(r)
      );
      if (results.length === 0) {
        console.log(
          `[${getMSTTimestamp()}] No tee times found for the specified criteria on ${
            config.date
          }.`
        );
        emailBody += `No tee times found for the specified criteria on ${config.date}.\n`;
      } else if (newResults.length > 0) {
        console.log(`[${getMSTTimestamp()}] New tee times for ${config.date}`);
        newResults.forEach((r) =>
          console.log(`[${getMSTTimestamp()}] Time: ${r}`)
        );
        emailBody +=
          `We have found the following tee times for you on ${config.date}:\n` +
          newResults.map((r) => `Time: ${r}`).join("\n") +
          "\n";
        shouldSendEmail = true;
      } else {
        console.log(
          `[${getMSTTimestamp()}] No new tee times since last check for ${
            config.date
          }.`
        );
        emailBody += `No new tee times since last check for ${config.date}.\n`;
      }
      // Update lastResults for next iteration only (not saved to file)
      config.lastResults = currentResults;
    }

    // After checking both days, send email if any new results were found
    if (shouldSendEmail) {
      try {
        await sgMail.send({
          from: process.env.SENDGRID_FROM || "brocklchelle@gmail.com",
          to: "brocklchelle@gmail.com",
          subject: "Kananaskis Tee Times",
          text: emailBody,
        });
        console.log(`[${getMSTTimestamp()}] Email sent!`);
      } catch (err) {
        console.error(`[${getMSTTimestamp()}] Failed to send email:`, err);
      }
    } else {
      console.log(
        `[${getMSTTimestamp()}] No new tee times since last check for either day.`
      );
    }
    // Wait 30 seconds before next polling cycle
    await page.waitForTimeout(30000);
  }
})();
