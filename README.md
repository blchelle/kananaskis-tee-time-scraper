# Kananaskis Tee Time Scraper

This project scrapes the Kananaskis golf booking site for available tee times on July 12, 2025, after 8am and before 4pm, for 4 players and 18 holes.

## Usage

1. Install dependencies:
   ```sh
   npm install
   ```
2. Run the scraper:
   ```sh
   npx ts-node src/scrape.ts
   ```

## Tech Stack

- Node.js
- TypeScript
- Playwright

## Customization

Modify `src/scrape.ts` to change the date, time, number of players, or holes.
