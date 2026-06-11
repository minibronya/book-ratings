import type { Browser } from "playwright";

export const GOODREADS_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// A stable, popular book page that always carries JSON-LD once the AWS WAF
// challenge is solved.
const SOLVE_URL =
  process.env.WAF_SOLVE_URL ?? "https://www.goodreads.com/book/show/2239941";

let cachedToken: string | null = null;
let solving: Promise<string | null> | null = null;

export function currentWafToken(): string | null {
  return cachedToken;
}

/**
 * Returns a valid aws-waf-token, solving the AWS WAF JS challenge in a headless
 * browser if needed. Single-flight: concurrent callers share one solve.
 */
export async function refreshWafToken(): Promise<string | null> {
  if (solving) {
    return solving;
  }
  solving = solveWafToken()
    .then((token) => {
      if (token) {
        cachedToken = token;
      }
      return token;
    })
    .finally(() => {
      solving = null;
    });
  return solving;
}

async function solveWafToken(): Promise<string | null> {
  const { chromium } = await import("playwright");
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent: GOODREADS_UA,
      locale: "en-US",
    });
    const page = await context.newPage();
    await page.goto(SOLVE_URL, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    // The challenge page reloads itself after solving; wait for real content.
    try {
      await page.waitForFunction(
        () => !!document.querySelector('script[type="application/ld+json"]'),
        { timeout: 45000 },
      );
    } catch {
      // Fall through: a token may still have been set even if the wait timed out.
    }

    const cookies = await context.cookies();
    const waf = cookies.find((c) => c.name === "aws-waf-token");
    return waf?.value ?? null;
  } catch {
    return null;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}
