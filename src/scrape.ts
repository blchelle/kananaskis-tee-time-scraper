import dotenv from "dotenv";
dotenv.config();

import { chromium } from "playwright";
import nodemailer from "nodemailer";

// Set up nodemailer transporter for Gmail SMTP
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS,
  },
});

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1300, height: 900 },
  });
  const page = await context.newPage();

  // Construct the search URL
  const url = `https://kananaskisabresidents.cps.golf/onlineresweb/search-teetime?TeeOffTimeMin=0&TeeOffTimeMax=23`;
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

  // Step 2: Click the 14th day of the month
  await page.click("div.day-unit:nth-child(14)");
  await page.waitForTimeout(500);

  // Step 3: Click the 18 holes toggle and start polling loop
  const toggleButtons = await page.$$(
    ".mat-button-toggle-group .mat-button-toggle-button"
  );
  // Initial click on the 3rd button (4 players)
  // await toggleButtons[2].click();

  await page.waitForTimeout(500);
  // Neverending polling loop, no need to toggle buttons for refresh
  let lastResults: string[] = [];
  while (true) {
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
    let emailBody = "";
    // Only send email if there is a new result
    const newResults = currentResults.filter((r) => !lastResults.includes(r));
    if (results.length === 0) {
      emailBody = "No tee times found for the specified criteria.";
      console.log(emailBody);
    } else if (newResults.length > 0) {
      emailBody =
        "Hi Brock, we have found the following tee times for you on July 12th, 2025:\n" +
        newResults.map((r) => `Time: ${r}`).join("\n");
      console.log("New tee times:");
      newResults.forEach((r) => console.log(`Time: ${r}`));

      // Send email only if new results were found
      try {
        await transporter.sendMail({
          from: process.env.GMAIL_USER || "your_gmail@gmail.com",
          to: "brocklchelle@gmail.com",
          subject: "Kananaskis Tee Times",
          text: emailBody,
        });
        console.log("Email sent!");
      } catch (err) {
        console.error("Failed to send email:", err);
      }
      // Update lastResults for next iteration only (not saved to file)
      lastResults = currentResults;
    } else {
      console.log("No new tee times since last check.");
      lastResults = currentResults;
    }
    // 3. Wait 30 seconds, then restart
    await page.waitForTimeout(30000);
  }
})();
