# Kananaskis Tee Time Scraper

Scrapes the Kananaskis golf booking site for available tee times.

## Usage

1. Install dependencies:
   ```sh
   npm install
   ```
2. Run the scraper:
   ```sh
   npx ts-node src/scrape.ts --dates <YYYY-MM-DD,YYYY-MM-DD> --start-time <hour> --end-time <hour> --golfers <1-4>
   ```

### Parameters

- `--dates`: Comma-separated dates (YYYY-MM-DD format)
- `--start-time`: Start hour in 24h format (0-23)
- `--end-time`: End hour in 24h format (0-23)
- `--golfers`: Number of golfers (1-4)

### Example

```sh
npx ts-node src/scrape.ts --dates 2025-07-11,2025-07-12 --start-time 8 --end-time 16 --golfers 4
```

## Tech Stack

- Node.js
- TypeScript
- Playwright
